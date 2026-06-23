import {
  cleanupEmptyDrafts,
  type DailyDraftPhotoRow,
  type PendingDailyReportRow,
  listPendingDailyReports,
  listPhotosToSync,
  notePendingReportAttempt,
  noteSyncAttempt,
  removePendingDailyReport,
  removePhotoFromIDB,
} from "./idb-photos"
import { presignAndUploadBlob } from "./storage-upload"

// ─── Photo sync runner ──────────────────────────────────────────────────────
// Drains tagged photos out of IndexedDB into the photos bucket + an
// item_photos row, then removes the IDB row IFF both confirm. Safe to call
// any number of times; idempotent end-to-end (Storage path encodes the
// IDB UUID, /api/photos POST upserts on the same UUID).
//
// Triggered from the UI on mount, on the `online` event, every 30 s while
// the page is visible, and immediately after a Create Report success or a
// fresh capture. NOT a service worker — iOS WKWebView eviction makes SW
// queues unsafe for native-wrapper compatibility (ADR-003).
//
// Failure policy (review-sensitive — see also removePhotoFromIDB):
//   - A failed upload increments the IDB row's `attempts` counter (already
//     present on every row via noteSyncAttempt). Counter never decrements.
//   - Between attempts the runner enforces exponential backoff so a flaky
//     server doesn't get hit every 30 s tick. Backoff is per-row, gated by
//     `lastAttemptAt` vs. wall-clock now.
//   - After MAX_ATTEMPTS failures the row enters a terminal "needs-attention"
//     state: drainPhotoQueue skips it entirely on subsequent passes. The
//     IDB row is NOT deleted — the photo bytes stay on the user's device,
//     visibly stuck in the UI, never silently dropped. Re-enabling retries
//     belongs to a future "retry stuck photo" affordance, not this runner.

/** Max sync attempts before a row is marked needs-attention and left stuck.
 *  Tuned with backoffMs so a permanently-broken upload terminates in ~10 min
 *  rather than retrying forever on every 30 s tick. */
export const MAX_ATTEMPTS = 10

/** Exponential backoff base; doubles each attempt up to BACKOFF_CAP_MS. */
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS  = 256_000

/** Max photos uploaded concurrently in a single drain pass. Bounded so a
 *  job-site phone overlaps the high-latency PUT round-trips (minutes → seconds
 *  for a 20-photo batch) without opening an unbounded number of sockets or
 *  hammering /api/photos. Only the OUTER per-photo iteration parallelizes;
 *  each uploadOne() stays internally sequential. */
const CONCURRENCY = 4

export interface DrainStats {
  uploaded: number
  failed: number
  skipped: number
  stuck: number
}

export type PhotoSyncStatus = "waiting" | "uploading" | "needs_attention"

// Module-level dedupe — a second drainPhotoQueue() call inside the same tab
// while one is already running becomes a no-op rather than racing the same
// rows. inFlight tracks per-photo claims so multiple drain *passes* (e.g.
// online event firing during a periodic tick) skip rows already uploading.
let isDraining = false
const inFlight = new Set<string>()
// Reports are claimed separately so their "pending sync" / "stuck" state in
// the list view is independent of any photo's in-flight state.
const inFlightReports = new Set<string>()

// Tiny pub/sub — components subscribe to be re-rendered after a drain
// finishes (so "(N syncing)" badges and the View modal photo grid stay
// current without polling). Also fired on each inFlight transition so the
// "Uploading…" overlay can appear for a photo while its upload is in flight,
// not just at end-of-drain.
type Listener = () => void
const subscribers = new Set<Listener>()

export function subscribeToPhotoSync(cb: Listener): () => void {
  subscribers.add(cb)
  return () => { subscribers.delete(cb) }
}

function notify(): void {
  subscribers.forEach(cb => {
    try { cb() } catch (err) { console.error("[photo-sync] listener threw", err) }
  })
}

/** Backoff window for a row with N failed attempts. attempts=0 → no delay. */
function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)
}

function isStuck(row: DailyDraftPhotoRow): boolean {
  return (row.attempts ?? 0) >= MAX_ATTEMPTS
}

function isWithinBackoff(row: DailyDraftPhotoRow, nowMs: number): boolean {
  const attempts = row.attempts ?? 0
  if (attempts <= 0) return false
  const last = row.lastAttemptAt ?? 0
  return (nowMs - last) < backoffMs(attempts)
}

// Same predicates for pending reports — same MAX_ATTEMPTS + backoff curve.
// A persistently-failing report stays in IDB indefinitely (terminal "stuck")
// rather than being silently dropped.
function isReportStuck(row: PendingDailyReportRow): boolean {
  return (row.attempts ?? 0) >= MAX_ATTEMPTS
}

function isReportWithinBackoff(row: PendingDailyReportRow, nowMs: number): boolean {
  const attempts = row.attempts ?? 0
  if (attempts <= 0) return false
  const last = row.lastAttemptAt ?? 0
  return (nowMs - last) < backoffMs(attempts)
}

/** Snapshot of currently-uploading photo IDs in this tab. Pure read; the
 *  returned set is a copy and may be retained safely by callers. */
export function getInFlightIds(): ReadonlySet<string> {
  return new Set(inFlight)
}

/** Derive a per-photo status for the UI. waiting = in IDB, not currently
 *  in flight, not stuck. uploading = currently being uploaded by this tab.
 *  needs_attention = MAX_ATTEMPTS reached, drainPhotoQueue will skip it
 *  until something else changes (user-initiated retry, future piece). */
export function derivePhotoStatus(
  row: DailyDraftPhotoRow,
  inFlightIds: ReadonlySet<string>,
): PhotoSyncStatus {
  if (inFlightIds.has(row.id)) return "uploading"
  if (isStuck(row)) return "needs_attention"
  return "waiting"
}

async function uploadOneReport(report: PendingDailyReportRow): Promise<void> {
  await notePendingReportAttempt(report.id)

  // /api/daily-reports POST upserts on the row id when client_id is a
  // valid UUID. A retried call returns the existing row instead of
  // colliding — safe to fire as many times as the runner needs.
  const res = await fetch("/api/daily-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: report.id, ...report.fields }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`/api/daily-reports returned ${res.status} ${detail}`)
  }
}

/** Drain the pending-reports queue. Same backoff + max-attempts policy as
 *  photos. The IDB row is removed IFF the POST returns 2xx. Returns counts;
 *  never throws. Called by drainPhotoQueue() before the photo pass. */
async function drainReportsOnce(): Promise<DrainStats> {
  const now = Date.now()
  let uploaded = 0
  let failed = 0
  let skipped = 0
  let stuck = 0
  const reports = await listPendingDailyReports()
  for (const report of reports) {
    if (inFlightReports.has(report.id)) { skipped++; continue }
    if (isReportStuck(report)) { stuck++; continue }
    if (isReportWithinBackoff(report, now)) { skipped++; continue }

    inFlightReports.add(report.id)
    notify()
    try {
      await uploadOneReport(report)
      // Server confirmed 2xx. The pending row is gone; the saved
      // daily_reports row now exists with id = report.id, so photos
      // tagged with savedReportId === report.id will attach cleanly
      // when their own drain pass runs.
      await removePendingDailyReport(report.id)
      uploaded++
    } catch (err) {
      console.error("[report-sync] upload failed for", report.id, err)
      failed++
    } finally {
      inFlightReports.delete(report.id)
      notify()
    }
  }
  return { uploaded, failed, skipped, stuck }
}

async function uploadOne(photo: DailyDraftPhotoRow): Promise<void> {
  if (!photo.savedReportId) throw new Error("photo has no savedReportId — refusing to upload")

  await noteSyncAttempt(photo.id)

  // 1. PUT bytes into Supabase Storage. Path is deterministic (presigned-url
  //    route uses our client_id as the unique segment), upsert:true on the
  //    bucket means a partial retry overwrites the same key — no orphans.
  const { path } = await presignAndUploadBlob(
    "photos",
    `daily_report/${photo.savedReportId}`,
    photo.bytes,
    photo.filename,
    photo.id,
  )

  // 2. Insert (or upsert-on-id) the item_photos row. Server treats the
  //    upsert on id as idempotent — second call returns the existing row.
  const res = await fetch("/api/photos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: photo.id,
      entity_type: "daily_report",
      entity_id: photo.savedReportId,
      file_path: path,
      file_name: photo.filename,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`/api/photos returned ${res.status} ${detail}`)
  }
}

/** Drain every tagged photo. Returns counts; never throws. Callers that
 *  want UI feedback should subscribe via subscribeToPhotoSync(). */
export async function drainPhotoQueue(): Promise<DrainStats> {
  if (isDraining) return { uploaded: 0, failed: 0, skipped: 0, stuck: 0 }
  isDraining = true
  let uploaded = 0
  let failed = 0
  let skipped = 0
  let stuck = 0
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Cheap short-circuit. Doesn't prevent retries — the next `online`
      // event will call us again.
      return { uploaded, failed, skipped, stuck }
    }

    // Reports first. Photos tagged with savedReportId === report.id depend
    // on the server's daily_reports row existing — item_photos has no FK
    // on entity_id, so a photo CAN be inserted before the report row
    // (server upsert just creates an unattached row), but the View modal's
    // GET /api/photos query keys by entity_id, so the user sees nothing
    // until the daily_reports row is also there. Draining reports first
    // makes the post-reconnect "report appears with its photos" land in
    // a single sync pass.
    await drainReportsOnce()

    const now = Date.now()
    const photos = await listPhotosToSync()

    // Bounded-concurrency worker pool. The PUT-to-Storage round-trip dominates
    // wall-clock on cellular, so overlapping CONCURRENCY photos collapses a
    // 20-photo batch from sum-of-latencies to ~max-per-batch — without opening
    // unbounded sockets. uploadOne() itself stays sequential (presign → PUT →
    // POST); only this OUTER iteration parallelizes.
    //
    // The workers share one cursor into `photos`. `photos[cursor++]` is a
    // synchronous read-modify-write with no await between the read and the
    // increment, so each index is claimed by exactly one worker — race-free in
    // JS's single-threaded model. The skip guards + inFlight claim are
    // evaluated per photo at claim time, identical to the old serial pass, so
    // a row that became in-flight/stuck/backed-off since listPhotosToSync()
    // is still respected. The shared uploaded/failed/skipped/stuck counters
    // are likewise only mutated synchronously between awaits, so their
    // increments can't interleave.
    let cursor = 0
    async function photoWorker(): Promise<void> {
      while (cursor < photos.length) {
        const photo = photos[cursor++]
        if (inFlight.has(photo.id)) { skipped++; continue }
        if (isStuck(photo)) { stuck++; continue }
        if (isWithinBackoff(photo, now)) { skipped++; continue }

        inFlight.add(photo.id)
        notify()  // UI: photo enters "uploading"
        try {
          await uploadOne(photo)
          // BOTH Storage and the DB row confirmed. This is the only legitimate
          // delete-from-IDB call site — see removePhotoFromIDB header comment.
          await removePhotoFromIDB(photo.id)
          uploaded++
        } catch (err) {
          console.error("[photo-sync] upload failed for", photo.id, err)
          failed++
          // IDB row stays put. The next drain pass will respect the new
          // (incremented) attempts + backoff window. Storage upsert + DB
          // upsert make the eventual retry replay-safe. A failure here drops
          // only this photo — sibling workers keep draining the rest.
        } finally {
          inFlight.delete(photo.id)
          notify()  // UI: photo leaves "uploading" → waiting or removed
        }
      }
    }

    // Spawn at most CONCURRENCY workers (fewer when there are fewer photos),
    // then await the WHOLE pool before any tail cleanup runs below.
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, photos.length) },
      () => photoWorker(),
    )
    await Promise.all(workers)

    // Tail cleanup: any draft whose report is saved AND has zero remaining
    // photos can be removed from IDB. Cheap and bounded.
    await cleanupEmptyDrafts()
  } catch (err) {
    console.error("[photo-sync] drain pass threw", err)
  } finally {
    isDraining = false
    notify()
  }
  return { uploaded, failed, skipped, stuck }
}

/** Per-saved-report counts of photos still in IDB, split by terminal state.
 *  The list/badge UI needs both: "syncing" (will retry) vs "stuck" (won't). */
export async function getCountsByReport(): Promise<{
  syncing: Map<string, number>
  stuck: Map<string, number>
}> {
  const rows = await listPhotosToSync()
  const syncing = new Map<string, number>()
  const stuck = new Map<string, number>()
  for (const r of rows) {
    if (!r.savedReportId) continue
    const bucket = isStuck(r) ? stuck : syncing
    bucket.set(r.savedReportId, (bucket.get(r.savedReportId) ?? 0) + 1)
  }
  return { syncing, stuck }
}
