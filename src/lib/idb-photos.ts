import { openDB, type IDBPDatabase } from "idb"
import type { UploadablePhoto } from "./uploadable-photo"

// ─── Local-first photo storage (Piece 1) ────────────────────────────────────
// IndexedDB is the durable source of truth for a captured photo from the
// moment it leaves the camera until it has been confirmed uploaded. Tab
// close, refresh, airplane mode, phone lock — none of these may lose a
// photo. The DB lives in the user-agent profile, so it survives PWA wraps
// and the WKWebView/Android WebView a Capacitor shell would use.
//
// This module deliberately does not export a delete/cleanup helper —
// removing photos belongs to the upload + sync piece, which is reviewed
// separately. A captured photo stays until that piece confirms an upload.

const DB_NAME = "tuttohq-offline"
const DB_VERSION = 1

const DRAFTS_STORE = "daily_drafts"
const PHOTOS_STORE = "daily_draft_photos"
const PHOTOS_BY_DRAFT_INDEX = "by_draft"

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
}

export interface DailyDraftPhotoRow extends UploadablePhoto {
  id: string
  draftId: string
  /** Capture order within the draft, monotonically increasing. */
  orderIndex: number
  capturedAt: number
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
          db.createObjectStore(DRAFTS_STORE, { keyPath: "id" })
        }
        if (!db.objectStoreNames.contains(PHOTOS_STORE)) {
          const store = db.createObjectStore(PHOTOS_STORE, { keyPath: "id" })
          store.createIndex(PHOTOS_BY_DRAFT_INDEX, "draftId")
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
// Note: no delete here on purpose — see header comment.

export async function addDailyDraftPhoto(
  draftId: string,
  photo: UploadablePhoto,
  orderIndex: number,
): Promise<DailyDraftPhotoRow> {
  const row: DailyDraftPhotoRow = {
    id: crypto.randomUUID(),
    draftId,
    orderIndex,
    capturedAt: Date.now(),
    bytes: photo.bytes,
    mime: photo.mime,
    filename: photo.filename,
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
