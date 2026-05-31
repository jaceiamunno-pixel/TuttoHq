import {
  cleanupEmptyDrafts,
  countPhotosToSyncByReport,
  type DailyDraftPhotoRow,
  listPhotosToSync,
  noteSyncAttempt,
  removePhotoFromIDB,
} from "./idb-photos"
import { presignAndUploadBlob } from "./storage-upload"

// ─── Photo sync runner (Piece 2) ────────────────────────────────────────────
// Drains tagged photos out of IndexedDB into the photos bucket + an
// item_photos row, then removes the IDB row IFF both confirm. Safe to call
// any number of times; idempotent end-to-end (Storage path encodes the
// IDB UUID, /api/photos POST upserts on the same UUID).
//
// Triggered from the UI on mount, on the `online` event, every 30 s while
// the page is visible, and immediately after a Create Report success or a
// fresh capture. NOT a service worker — iOS WKWebView eviction makes SW
// queues unsafe for native-wrapper compatibility (ADR-003).

export interface DrainStats {
  uploaded: number
  failed: number
  skipped: number
}

// Module-level dedupe — a second drainPhotoQueue() call inside the same tab
// while one is already running becomes a no-op rather than racing the same
// rows. inFlight tracks per-photo claims so multiple drain *passes* (e.g.
// online event firing during a periodic tick) skip rows already uploading.
let isDraining = false
const inFlight = new Set<string>()

// Tiny pub/sub — components subscribe to be re-rendered after a drain
// finishes (so "(N syncing)" badges and the View modal photo grid stay
// current without polling).
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
  if (isDraining) return { uploaded: 0, failed: 0, skipped: 0 }
  isDraining = true
  let uploaded = 0
  let failed = 0
  let skipped = 0
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Cheap short-circuit. Doesn't prevent retries — the next `online`
      // event will call us again.
      return { uploaded, failed, skipped }
    }

    const photos = await listPhotosToSync()
    for (const photo of photos) {
      if (inFlight.has(photo.id)) { skipped++; continue }
      inFlight.add(photo.id)
      try {
        await uploadOne(photo)
        // BOTH Storage and the DB row confirmed. This is the only legitimate
        // delete-from-IDB call site — see removePhotoFromIDB header comment.
        await removePhotoFromIDB(photo.id)
        uploaded++
      } catch (err) {
        console.error("[photo-sync] upload failed for", photo.id, err)
        failed++
        // IDB row stays put. Next drain will retry — Storage upsert + DB
        // upsert make the retry safe.
      } finally {
        inFlight.delete(photo.id)
      }
    }

    // Tail cleanup: any draft whose report is saved AND has zero remaining
    // photos can be removed from IDB. Cheap and bounded.
    await cleanupEmptyDrafts()
  } catch (err) {
    console.error("[photo-sync] drain pass threw", err)
  } finally {
    isDraining = false
    notify()
  }
  return { uploaded, failed, skipped }
}

/** Current per-saved-report counts of photos still in IDB. Convenience
 *  re-export so the UI only needs to import from photo-sync.ts. */
export async function syncingCountsByReport(): Promise<Map<string, number>> {
  return countPhotosToSyncByReport()
}
