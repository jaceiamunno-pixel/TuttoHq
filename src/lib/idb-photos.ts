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
const DB_VERSION = 2

const DRAFTS_STORE = "daily_drafts"
const PHOTOS_STORE = "daily_draft_photos"
const PHOTOS_BY_DRAFT_INDEX = "by_draft"
const PHOTOS_BY_TARGET_INDEX = "by_target"

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

export async function addDailyDraftPhoto(
  draftId: string,
  photo: UploadablePhoto,
  orderIndex: number,
  savedReportId?: string,
): Promise<DailyDraftPhotoRow> {
  const row: DailyDraftPhotoRow = {
    id: crypto.randomUUID(),
    draftId,
    orderIndex,
    capturedAt: Date.now(),
    bytes: photo.bytes,
    mime: photo.mime,
    filename: photo.filename,
    ...(savedReportId ? { savedReportId } : {}),
  }
  const db = await getDB()
  await db.put(PHOTOS_STORE, row)
  return row
}

export async function listDailyDraftPhotos(draftId: string): Promise<DailyDraftPhotoRow[]> {
  const db = await getDB()
  const rows = (await db.getAllFromIndex(
    PHOTOS_STORE,
    PHOTOS_BY_DRAFT_INDEX,
    draftId,
  )) as DailyDraftPhotoRow[]
  rows.sort((a, b) => a.orderIndex - b.orderIndex)
  return rows
}

/** All photos for a given saved report — used by the View modal to merge
 *  IDB-resident "syncing" photos with the server-fetched ones. */
export async function listPhotosForSavedReport(savedReportId: string): Promise<DailyDraftPhotoRow[]> {
  const db = await getDB()
  const rows = (await db.getAllFromIndex(
    PHOTOS_STORE,
    PHOTOS_BY_TARGET_INDEX,
    savedReportId,
  )) as DailyDraftPhotoRow[]
  rows.sort((a, b) => a.orderIndex - b.orderIndex)
  return rows
}

/** Every photo with a target — the sync runner's queue. The by_target
 *  index naturally excludes photos that haven't been tagged yet (those
 *  belong to a draft still being edited). */
export async function listPhotosToSync(): Promise<DailyDraftPhotoRow[]> {
  const db = await getDB()
  return (await db.getAllFromIndex(PHOTOS_STORE, PHOTOS_BY_TARGET_INDEX)) as DailyDraftPhotoRow[]
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
    const row = cursor.value as DailyDraftPhotoRow
    if (row.savedReportId !== savedReportId) {
      await cursor.update({ ...row, savedReportId })
    }
    cursor = await cursor.continue()
  }

  await tx.done
}

/** Increment the attempts counter — bookkeeping only, never gates deletion. */
export async function noteSyncAttempt(photoId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(PHOTOS_STORE, "readwrite")
  const existing = (await tx.store.get(photoId)) as DailyDraftPhotoRow | undefined
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
  )) as DailyDraftPhotoRow[]
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
