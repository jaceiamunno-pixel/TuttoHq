import { openDB, type IDBPDatabase } from "idb"
import type { UploadablePhoto } from "./uploadable-photo"

// ─── Local-first photo storage (Pieces 1 + 2) ───────────────────────────────
// IndexedDB is the durable source of truth for a captured photo from the
// moment it leaves the camera until the upload + DB-insert pair has been
// confirmed (Piece 2). Tab close, refresh, airplane mode, phone lock —
// none of these may lose a photo. The DB lives in the user-agent profile,
// so it survives PWA wraps and the WKWebView/Android WebView a Capacitor
// shell would use.
//
// The delete helpers live in this module but are deliberately narrow:
// removePhotoFromIDB is only ever called by the sync runner after BOTH
// Storage and the DB row have confirmed; removeDraftIfEmpty only fires
// when a draft's tied report exists AND there are no remaining IDB
// photos for it. Anything else holding a Blob in IDB is a captured
// photo whose round-trip is incomplete.

const DB_NAME = "tuttohq-offline"
const DB_VERSION = 3

const DRAFTS_STORE = "daily_drafts"
const PHOTOS_STORE = "daily_draft_photos"
const PHOTOS_BY_DRAFT_INDEX = "by_draft"
const PHOTOS_BY_TARGET_INDEX = "by_target"
const PENDING_REPORTS_STORE = "pending_daily_reports"

// Active draft pointer lives in localStorage so the form can find the
// in-progress draft without hitting IDB first. The draft row in IDB is
// the source of truth; this is just a one-key bookmark.
export const ACTIVE_DAILY_DRAFT_KEY = "tuttohq:daily-draft:active-id"

export interface DailyDraftRow {
  id: string
  /** Form field state — a flat string bag matching the form inputs. */
  fields: Record<string, string>
  createdAt: number
  updatedAt: number
  /** Set by tagDraftWithSavedReport once /api/daily-reports has returned a
   *  row id. Bridges the client-only draft UUID to the server's report id
   *  so the sync runner knows where photos belong. */
  savedReportId?: string | null
}

export interface DailyDraftPhotoRow extends UploadablePhoto {
  id: string
  draftId: string
  /** Capture order within the draft, monotonically increasing. */
  orderIndex: number
  capturedAt: number
  /** Mirrored from the draft on tagDraftWithSavedReport. Only photos with
   *  this field set are visible to the sync runner via the by_target
   *  index — `undefined` keeps a row off the index entirely. */
  savedReportId?: string
  /** Bookkeeping for the drain runner. Never gates deletion. */
  attempts?: number
  lastAttemptAt?: number
}

/** A daily report that has been "created" locally — its photos are linked
 *  to its `id` in IDB — but whose server POST has not yet been confirmed
 *  successful. The sync runner POSTs each pending row to /api/daily-reports
 *  with `client_id = id`, which the server upserts onto `daily_reports.id`.
 *  Removed from this store IFF /api/daily-reports returns 2xx.
 *
 *  This is the row that makes "the report exists" hold offline. Without it,
 *  a failed report POST leaves the photos orphaned (tagged with an id no
 *  server row will ever exist for, since the client forgot the id). */
export interface PendingDailyReportRow {
  id: string
  /** Same flat string bag the original POST handler accepts. */
  fields: Record<string, string>
  createdAt: number
  /** Sync-runner bookkeeping. Mirrors the photo runner's semantics. */
  attempts?: number
  lastAttemptAt?: number
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore(DRAFTS_STORE, { keyPath: "id" })
          const photos = db.createObjectStore(PHOTOS_STORE, { keyPath: "id" })
          photos.createIndex(PHOTOS_BY_DRAFT_INDEX, "draftId")
        }
        if (oldVersion < 2) {
          // by_target only contains rows whose savedReportId is a non-null
          // string. Old Piece-1 rows have no such field and stay invisible
          // to the sync runner (they had no server target to begin with).
          const photos = transaction.objectStore(PHOTOS_STORE)
          if (!photos.indexNames.contains(PHOTOS_BY_TARGET_INDEX)) {
            photos.createIndex(PHOTOS_BY_TARGET_INDEX, "savedReportId")
          }
        }
        if (oldVersion < 3) {
          // Pending daily-reports queue. Adding the store leaves prior
          // data untouched — drafts and photos already in IDB keep
          // working. The store is empty until the next createDaily.
          if (!db.objectStoreNames.contains(PENDING_REPORTS_STORE)) {
            db.createObjectStore(PENDING_REPORTS_STORE, { keyPath: "id" })
          }
        }
      },
    })
  }
  return dbPromise
}

// ─── Drafts ─────────────────────────────────────────────────────────────────

export async function putDailyDraft(row: DailyDraftRow): Promise<void> {
  const db = await getDB()
  await db.put(DRAFTS_STORE, { ...row, updatedAt: Date.now() })
}

export async function getDailyDraft(id: string): Promise<DailyDraftRow | undefined> {
  const db = await getDB()
  return db.get(DRAFTS_STORE, id) as Promise<DailyDraftRow | undefined>
}

// ─── Photos ─────────────────────────────────────────────────────────────────
//
// iOS-Safari note: WebKit's IndexedDB implementation fails serialization on
// Blobs produced by certain canvas APIs (canvas.toBlob / OffscreenCanvas
// .convertToBlob) with the runtime error
//
//   "Error preparing Blob/File data to be stored in object store"
//
// ArrayBuffer serialization through the typed-array path works on all
// browsers. So we materialize Blob → ArrayBuffer at the write boundary and
// reconstruct ArrayBuffer → Blob at the read boundary. The public
// DailyDraftPhotoRow / UploadablePhoto contract stays Blob-only — callers
// (the compressor, the upload helper, DraftPhotoThumb) never see the
// stored shape. The detection on read tolerates legacy Blob rows written
// by earlier builds on Chrome/Android profiles, so no data migration is
// required.

/** Internal persistent shape. Never escapes this module. */
interface StoredDailyDraftPhotoRow {
  id: string
  draftId: string
  orderIndex: number
  capturedAt: number
  /** ArrayBuffer for rows written by this build; Blob for legacy rows. */
  bytes: ArrayBuffer | Blob
  mime: string
  filename: string
  savedReportId?: string
  attempts?: number
  lastAttemptAt?: number
}

/** Read-boundary conversion. Reconstructs a Blob from whichever shape was
 *  persisted so the caller always works with the documented Blob type. */
function rowFromStored(stored: StoredDailyDraftPhotoRow): DailyDraftPhotoRow {
  const bytes: Blob = stored.bytes instanceof Blob
    ? stored.bytes
    : new Blob([stored.bytes], { type: stored.mime || "image/jpeg" })
  return {
    id: stored.id,
    draftId: stored.draftId,
    orderIndex: stored.orderIndex,
    capturedAt: stored.capturedAt,
    bytes,
    mime: stored.mime,
    filename: stored.filename,
    savedReportId: stored.savedReportId,
    attempts: stored.attempts,
    lastAttemptAt: stored.lastAttemptAt,
  }
}

export async function addDailyDraftPhoto(
  draftId: string,
  photo: UploadablePhoto,
  orderIndex: number,
  savedReportId?: string,
): Promise<DailyDraftPhotoRow> {
  // Materialize once, here. Whatever the compressor handed us — Blob from
  // canvas.toBlob (Safari path), OffscreenCanvas.convertToBlob, or
  // heic2any — becomes a plain ArrayBuffer before IDB sees it.
  const buf = await photo.bytes.arrayBuffer()
  const stored: StoredDailyDraftPhotoRow = {
    id: crypto.randomUUID(),
    draftId,
    orderIndex,
    capturedAt: Date.now(),
    bytes: buf,
    mime: photo.mime,
    filename: photo.filename,
    ...(savedReportId ? { savedReportId } : {}),
  }
  const db = await getDB()
  await db.put(PHOTOS_STORE, stored)
  return rowFromStored(stored)
}

export async function listDailyDraftPhotos(draftId: string): Promise<DailyDraftPhotoRow[]> {
  const db = await getDB()
  const rows = (await db.getAllFromIndex(
    PHOTOS_STORE,
    PHOTOS_BY_DRAFT_INDEX,
    draftId,
  )) as StoredDailyDraftPhotoRow[]
  rows.sort((a, b) => a.orderIndex - b.orderIndex)
  return rows.map(rowFromStored)
}

/** All photos for a given saved report — used by the View modal to merge
 *  IDB-resident "syncing" photos with the server-fetched ones. */
export async function listPhotosForSavedReport(savedReportId: string): Promise<DailyDraftPhotoRow[]> {
  const db = await getDB()
  const rows = (await db.getAllFromIndex(
    PHOTOS_STORE,
    PHOTOS_BY_TARGET_INDEX,
    savedReportId,
  )) as StoredDailyDraftPhotoRow[]
  rows.sort((a, b) => a.orderIndex - b.orderIndex)
  return rows.map(rowFromStored)
}

/** Every photo with a target — the sync runner's queue. The by_target
 *  index naturally excludes photos that haven't been tagged yet (those
 *  belong to a draft still being edited). */
export async function listPhotosToSync(): Promise<DailyDraftPhotoRow[]> {
  const db = await getDB()
  const rows = (await db.getAllFromIndex(PHOTOS_STORE, PHOTOS_BY_TARGET_INDEX)) as StoredDailyDraftPhotoRow[]
  return rows.map(rowFromStored)
}

/** Bridge: a just-created daily_reports.id is stamped onto the draft and
 *  every one of its photos in one IDB transaction. After this, the photos
 *  are visible to the by_target index → the sync runner will pick them
 *  up on the next tick. */
export async function tagDraftWithSavedReport(
  draftId: string,
  savedReportId: string,
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([DRAFTS_STORE, PHOTOS_STORE], "readwrite")

  const draft = (await tx.objectStore(DRAFTS_STORE).get(draftId)) as DailyDraftRow | undefined
  if (draft) {
    await tx.objectStore(DRAFTS_STORE).put({
      ...draft,
      savedReportId,
      updatedAt: Date.now(),
    })
  }

  const photosStore = tx.objectStore(PHOTOS_STORE)
  const photosByDraft = photosStore.index(PHOTOS_BY_DRAFT_INDEX)
  let cursor = await photosByDraft.openCursor(IDBKeyRange.only(draftId))
  while (cursor) {
    // Cast to the persistent shape — bytes is ArrayBuffer (new rows) or
    // Blob (legacy). Spread preserves whatever bytes shape was there;
    // we only touch savedReportId. No conversion needed.
    const stored = cursor.value as StoredDailyDraftPhotoRow
    if (stored.savedReportId !== savedReportId) {
      await cursor.update({ ...stored, savedReportId })
    }
    cursor = await cursor.continue()
  }

  await tx.done
}

// ─── Reconciliation sweep (recovery net for already-orphaned photos) ─────────
//
// An orphan is a photo row whose savedReportId was never stamped — the key is
// ABSENT, so the row is excluded from the by_target index and is therefore
// invisible to the sync runner and every badge. This happens when a create
// tagged a partial set, or a tag transaction failed after the report was
// already queued/saved.
//
// Safety property (LOAD-BEARING): the ONLY value ever written to a photo's
// savedReportId is that photo's OWN draftId, read off the row itself. It is
// structurally impossible to tag a photo onto a different report — the report
// id always equals the draft id (clientReportId = draftId; server upserts on
// client_id), for both the create path and the view-modal path.
//
// A photo is re-tagged IFF its draft has durable, client-only evidence that the
// report was actually saved:
//   - the draft row carries savedReportId === draftId (tag succeeded for the
//     draft but a late photo missed the cursor), OR
//   - a pending_daily_reports row with id === draftId still exists (report
//     created locally, POST not yet confirmed).
// An abandoned draft has neither, so it is never resurrected. The draft the
// user may still be composing is excluded via activeDraftId.
//
// Idempotent and concurrency-safe: each draft is handled in its own
// transaction; rows are re-read inside the write tx and skipped if already
// stamped, so a concurrent create that tagged a row first is never clobbered.

export async function reconcileOrphanedDailyPhotos(
  activeDraftId: string | null,
): Promise<{ repaired: number; reports: number }> {
  const db = await getDB()
  const all = (await db.getAll(PHOTOS_STORE)) as StoredDailyDraftPhotoRow[]
  // Orphans: savedReportId absent (undefined) or null — `== null` catches both.
  const orphans = all.filter((r) => r.savedReportId == null && !!r.draftId)
  if (orphans.length === 0) return { repaired: 0, reports: 0 }

  // Group by draftId so each draft's saved-evidence is checked once.
  const byDraft = new Map<string, StoredDailyDraftPhotoRow[]>()
  for (const o of orphans) {
    const arr = byDraft.get(o.draftId)
    if (arr) arr.push(o)
    else byDraft.set(o.draftId, [o])
  }

  let repaired = 0
  const repairedReports = new Set<string>()

  for (const [draftId, rows] of byDraft) {
    // Exclude the draft the user may be actively composing — its untagged
    // photos are legitimately pending creation, not orphans.
    if (activeDraftId && draftId === activeDraftId) continue

    // One transaction per draft: read the saved-evidence and write the stamps
    // atomically so the decision and the writes can't be split by a concurrent
    // create touching the same rows.
    const tx = db.transaction([DRAFTS_STORE, PHOTOS_STORE, PENDING_REPORTS_STORE], "readwrite")
    const draft = (await tx.objectStore(DRAFTS_STORE).get(draftId)) as DailyDraftRow | undefined
    const pending = (await tx
      .objectStore(PENDING_REPORTS_STORE)
      .get(draftId)) as PendingDailyReportRow | undefined
    const wasSaved = draft?.savedReportId === draftId || pending != null

    if (wasSaved) {
      // Mirror tagDraftWithSavedReport: stamp the draft row too (when not
      // already stamped) so removeDraftIfEmpty can retire it once its photos
      // finish syncing. The value is the draft's own id — never a foreign id.
      if (draft && draft.savedReportId !== draftId) {
        await tx
          .objectStore(DRAFTS_STORE)
          .put({ ...draft, savedReportId: draftId, updatedAt: Date.now() })
      }
      const photosStore = tx.objectStore(PHOTOS_STORE)
      for (const row of rows) {
        const cur = (await photosStore.get(row.id)) as StoredDailyDraftPhotoRow | undefined
        // Skip if a concurrent create already tagged it (idempotent).
        if (cur && cur.savedReportId == null) {
          await photosStore.put({ ...cur, savedReportId: draftId })
          repaired++
          repairedReports.add(draftId)
        }
      }
    }
    await tx.done
  }

  return { repaired, reports: repairedReports.size }
}

/** Increment the attempts counter — bookkeeping only, never gates deletion. */
export async function noteSyncAttempt(photoId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(PHOTOS_STORE, "readwrite")
  // Persistent-shape cast — we only touch attempts/lastAttemptAt; the
  // bytes blob/buffer is round-tripped untouched.
  const existing = (await tx.store.get(photoId)) as StoredDailyDraftPhotoRow | undefined
  if (existing) {
    await tx.store.put({
      ...existing,
      attempts: (existing.attempts ?? 0) + 1,
      lastAttemptAt: Date.now(),
    })
  }
  await tx.done
}

// ─── Delete (review-sensitive) ──────────────────────────────────────────────
//
// removePhotoFromIDB is the single point where a captured photo can leave
// local storage. The sync runner is the only legitimate caller, and it
// may only call this after BOTH Storage 2xx AND /api/photos 2xx in the
// same drain pass. Any new code calling this must satisfy the same rule.

export async function removePhotoFromIDB(photoId: string): Promise<void> {
  const db = await getDB()
  await db.delete(PHOTOS_STORE, photoId)
}

/** Remove a draft row IFF its report has been saved AND no photos remain
 *  for it in IDB. Called at the tail of a drain pass — bookkeeping cleanup
 *  for fully-synced drafts. */
export async function removeDraftIfEmpty(draftId: string): Promise<boolean> {
  const db = await getDB()
  const draft = (await db.get(DRAFTS_STORE, draftId)) as DailyDraftRow | undefined
  if (!draft) return false
  if (!draft.savedReportId) return false
  const photos = (await db.getAllFromIndex(
    PHOTOS_STORE,
    PHOTOS_BY_DRAFT_INDEX,
    draftId,
  )) as StoredDailyDraftPhotoRow[]
  if (photos.length > 0) return false
  await db.delete(DRAFTS_STORE, draftId)
  return true
}

/** Sweep every draft that is fully synced (saved + zero photos). Cheap
 *  enough to call at the end of each drain pass. */
export async function cleanupEmptyDrafts(): Promise<number> {
  const db = await getDB()
  const drafts = (await db.getAll(DRAFTS_STORE)) as DailyDraftRow[]
  let removed = 0
  for (const d of drafts) {
    if (await removeDraftIfEmpty(d.id)) removed++
  }
  return removed
}

// ─── Pending reports ────────────────────────────────────────────────────────
// Lifecycle: createDaily writes a row here BEFORE the optimistic POST. The
// sync runner posts it to /api/daily-reports with client_id = id, and on
// 2xx removes the row via removePendingDailyReport. removePendingDailyReport
// is to pending-reports what removePhotoFromIDB is to photos — it is the
// SOLE legitimate exit. Any other caller is a bug.

export async function putPendingDailyReport(row: PendingDailyReportRow): Promise<void> {
  const db = await getDB()
  await db.put(PENDING_REPORTS_STORE, row)
}

export async function getPendingDailyReport(id: string): Promise<PendingDailyReportRow | undefined> {
  const db = await getDB()
  return db.get(PENDING_REPORTS_STORE, id) as Promise<PendingDailyReportRow | undefined>
}

/** Newest-first so the merged list view shows fresh creates at the top. */
export async function listPendingDailyReports(): Promise<PendingDailyReportRow[]> {
  const db = await getDB()
  const rows = (await db.getAll(PENDING_REPORTS_STORE)) as PendingDailyReportRow[]
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

export async function removePendingDailyReport(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(PENDING_REPORTS_STORE, id)
}

/** Increment the attempts counter — bookkeeping only, never gates deletion. */
export async function notePendingReportAttempt(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(PENDING_REPORTS_STORE, "readwrite")
  const existing = (await tx.store.get(id)) as PendingDailyReportRow | undefined
  if (existing) {
    await tx.store.put({
      ...existing,
      attempts: (existing.attempts ?? 0) + 1,
      lastAttemptAt: Date.now(),
    })
  }
  await tx.done
}
