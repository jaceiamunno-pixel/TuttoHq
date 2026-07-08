import type {
  Takeoff, TakeoffBundle, TakeoffCategory, TakeoffRoom, TakeoffTag, TakeoffMark,
  TakeoffPageScale, CountSheet, MarkKind, Pt, ScaleUnit,
} from "./types"

// Thin client data layer: every call hits an /api/takeoffs route (server resolves
// auth + company; RLS scopes tenant). The client never sends company_id. Reads
// select by takeoff_id; writes insert/delete single rows.

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
  return body
}

// ── Drawing sheets — reuse the Drawings section's own source ──────────────────
// The sheet picker reads the SAME data the Drawings/markup viewer uses: the
// drawing_sheets table (ADR-005) via GET /api/drawings/sheets — NOT the legacy
// drawing_log (/api/drawings), which is empty for current projects. That route
// returns each sheet already joined to its current revision's signed PDF URL
// (drawing_revisions.storage_path, "submittals" bucket, 1h) and filters
// deleted_at IS NULL server-side. We keep only renderable sheets (file_url set).
export async function listSheets(projectId: string): Promise<CountSheet[]> {
  const body = await jsonOrThrow(await fetch(`/api/drawings/sheets?project_id=${encodeURIComponent(projectId)}`))
  type Row = { id: string; sheet_number?: string | null; title?: string | null; file_url: string | null }
  return ((body.sheets ?? []) as Row[])
    .filter(s => !!s.file_url)
    .map(s => ({
      id: s.id,                       // drawing_sheets.id — stable across revisions; stored as source_ref
      sheet_number: s.sheet_number ?? null,
      sheet_title: s.title ?? null,   // the route exposes the sheet title as `title`
      file_url: s.file_url,
    }))
}

// ── Takeoffs ──────────────────────────────────────────────────────────────────
export async function listTakeoffs(projectId: string): Promise<Takeoff[]> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs?project_id=${encodeURIComponent(projectId)}`))
  return body.takeoffs ?? []
}

export async function createTakeoff(projectId: string, name: string): Promise<Takeoff> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, name }),
  }))
  return body.takeoff
}

export async function getBundle(takeoffId: string): Promise<TakeoffBundle> {
  return jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}`))
}

export async function deleteTakeoff(takeoffId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}`, { method: "DELETE" }))
}

// ── Categories ─────────────────────────────────────────────────────────────────
export async function createCategory(takeoffId: string, name: string, sortOrder: number): Promise<TakeoffCategory> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/categories`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, sort_order: sortOrder }),
  }))
  return body.category
}
export async function updateCategory(takeoffId: string, categoryId: string, patch: { name?: string; sort_order?: number }): Promise<TakeoffCategory> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/categories`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category_id: categoryId, ...patch }),
  }))
  return body.category
}
export async function deleteCategory(takeoffId: string, categoryId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/categories?category_id=${encodeURIComponent(categoryId)}`, { method: "DELETE" }))
}

// ── Rooms ───────────────────────────────────────────────────────────────────────
export async function createRoom(takeoffId: string, name: string, sortOrder: number): Promise<TakeoffRoom> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/rooms`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, sort_order: sortOrder }),
  }))
  return body.room
}
export async function updateRoom(takeoffId: string, roomId: string, patch: { name?: string; sort_order?: number }): Promise<TakeoffRoom> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/rooms`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room_id: roomId, ...patch }),
  }))
  return body.room
}
export async function deleteRoom(takeoffId: string, roomId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/rooms?room_id=${encodeURIComponent(roomId)}`, { method: "DELETE" }))
}

// ── Tags ─────────────────────────────────────────────────────────────────────────
export async function createTag(takeoffId: string, input: { code: string; description: string | null; color: string; category_id: string | null; sort_order: number }): Promise<TakeoffTag> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
  return body.tag
}
export async function updateTag(takeoffId: string, tagId: string, patch: { code?: string; description?: string | null; color?: string; category_id?: string | null; sort_order?: number }): Promise<TakeoffTag> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/tags`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_id: tagId, ...patch }),
  }))
  return body.tag
}
export async function deleteTag(takeoffId: string, tagId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/tags?tag_id=${encodeURIComponent(tagId)}`, { method: "DELETE" }))
}

// ── Marks (count + measurement) ─────────────────────────────────────────────────
export interface CreateMarkInput {
  tag_id: string
  room_id: string
  source_ref: string | null
  page: number
  x: number
  y: number
  kind: MarkKind
  points: Pt[] | null
  raw_measure: number | null
}
export async function createMark(takeoffId: string, input: CreateMarkInput): Promise<TakeoffMark> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/marks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
  return body.mark
}
export async function deleteMark(takeoffId: string, markId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/marks?mark_id=${encodeURIComponent(markId)}`, { method: "DELETE" }))
}

// ── Page scales (calibration) ────────────────────────────────────────────────────
// A scale belongs to a (sheet, page): source_ref is the drawing_sheets id, the same
// value the sheet's marks carry (null for an ad-hoc PDF with no ingested sheet).
export async function upsertScale(takeoffId: string, input: {
  source_ref: string | null; page: number; units_per_px: number; unit: ScaleUnit
  cal_x1: number; cal_y1: number; cal_x2: number; cal_y2: number
}): Promise<TakeoffPageScale> {
  const body = await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/scales`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
  return body.scale
}
export async function deleteScale(takeoffId: string, sourceRef: string | null, page: number): Promise<void> {
  const qs = new URLSearchParams({ page: String(page) })
  if (sourceRef != null) qs.set("source_ref", sourceRef)
  await jsonOrThrow(await fetch(`/api/takeoffs/${takeoffId}/scales?${qs.toString()}`, { method: "DELETE" }))
}
