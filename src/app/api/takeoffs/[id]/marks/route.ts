import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, childBelongsToTakeoff } from "../../_helpers"

// Takeoff marks — one row per count dot OR measurement (Phase B) on a sheet.
// POST insert, DELETE remove. x,y are normalized [0,1] to the sheet page (the
// label anchor); source_ref identifies the open sheet (drawing_sheets id); page is
// the page index. kind='count' uses only x,y; kind='linear'/'area' also carry an
// ordered `points` polyline/polygon and a pre-scale `raw_measure` (real-world
// quantity is resolved at read time from the page's takeoff_page_scales row).

const MARK_SELECT = "id, takeoff_id, tag_id, room_id, source_ref, page, x, y, kind, points, raw_measure"

// Parse [[x,y],...] of finite numbers; returns null if the shape is wrong.
function parsePoints(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null
  const out: [number, number][] = []
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return null
    const x = Number(p[0]), y = Number(p[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    out.push([x, y])
  }
  return out
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase, companyId } = ctx
  const { id: takeoffId } = await params

  const body = await req.json().catch(() => ({}))
  const tagId = typeof body.tag_id === "string" ? body.tag_id : ""
  const roomId = typeof body.room_id === "string" ? body.room_id : ""
  const sourceRef = typeof body.source_ref === "string" ? body.source_ref : null
  const page = Number.isFinite(body.page) ? Number(body.page) : 0
  const x = Number(body.x)
  const y = Number(body.y)
  const kind = body.kind === "linear" || body.kind === "area" ? body.kind : "count"
  if (!tagId) return badRequest("tag_id is required")
  if (!roomId) return badRequest("room_id is required")
  if (!Number.isFinite(x) || !Number.isFinite(y)) return badRequest("x and y are required")

  // Measurement marks additionally carry geometry + a non-negative raw measure.
  let points: [number, number][] | null = null
  let rawMeasure: number | null = null
  if (kind !== "count") {
    points = parsePoints(body.points)
    const min = kind === "area" ? 3 : 2
    if (!points || points.length < min) return badRequest(`${kind} marks need at least ${min} points`)
    rawMeasure = Number(body.raw_measure)
    if (!Number.isFinite(rawMeasure) || rawMeasure < 0) return badRequest("raw_measure must be a non-negative number")
  }

  if (!(await childBelongsToTakeoff(supabase, takeoffId, { tagId, roomId }))) {
    return NextResponse.json({ error: "tag or room does not belong to this takeoff" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("takeoff_marks")
    .insert({
      takeoff_id: takeoffId, company_id: companyId, tag_id: tagId, room_id: roomId,
      source_ref: sourceRef, page, x, y, kind, points, raw_measure: rawMeasure,
    })
    .select(MARK_SELECT).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ mark: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params
  const markId = req.nextUrl.searchParams.get("mark_id")
  if (!markId) return badRequest("mark_id is required")

  const { error } = await supabase
    .from("takeoff_marks").delete().eq("id", markId).eq("takeoff_id", takeoffId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
