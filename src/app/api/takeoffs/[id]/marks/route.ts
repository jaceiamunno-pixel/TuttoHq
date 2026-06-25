import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, childBelongsToTakeoff } from "../../_helpers"

// Count marks — one row per dot dropped on a sheet. POST insert, DELETE remove.
// x,y are normalized [0,1] to the sheet page; source_ref identifies the open sheet
// (the drawing_log row id); page is the page index (the reused viewer is page-0).

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
  if (!tagId) return badRequest("tag_id is required")
  if (!roomId) return badRequest("room_id is required")
  if (!Number.isFinite(x) || !Number.isFinite(y)) return badRequest("x and y are required")
  if (!(await childBelongsToTakeoff(supabase, takeoffId, { tagId, roomId }))) {
    return NextResponse.json({ error: "tag or room does not belong to this takeoff" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("takeoff_marks")
    .insert({
      takeoff_id: takeoffId, company_id: companyId, tag_id: tagId, room_id: roomId,
      source_ref: sourceRef, page, x, y,
    })
    .select("id, takeoff_id, tag_id, room_id, source_ref, page, x, y").single()
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
