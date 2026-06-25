import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, takeoffExists } from "../../_helpers"

// Editable room list (matrix columns). POST add, PATCH rename/reorder, DELETE.
// Deleting a room drops its marks first (removing that column's counts) so the
// delete can't trip an FK.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase, companyId } = ctx
  const { id: takeoffId } = await params
  if (!(await takeoffExists(supabase, takeoffId))) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0
  if (!name) return badRequest("name is required")

  const { data, error } = await supabase
    .from("takeoff_rooms")
    .insert({ takeoff_id: takeoffId, company_id: companyId, name, sort_order: sortOrder })
    .select("id, takeoff_id, name, sort_order").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ room: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params

  const body = await req.json().catch(() => ({}))
  const roomId = typeof body.room_id === "string" ? body.room_id : ""
  if (!roomId) return badRequest("room_id is required")
  const patch: Record<string, unknown> = {}
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim()
  if (Number.isFinite(body.sort_order)) patch.sort_order = Number(body.sort_order)
  if (Object.keys(patch).length === 0) return badRequest("nothing to update")

  const { data, error } = await supabase
    .from("takeoff_rooms").update(patch)
    .eq("id", roomId).eq("takeoff_id", takeoffId)
    .select("id, takeoff_id, name, sort_order").maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ room: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params
  const roomId = req.nextUrl.searchParams.get("room_id")
  if (!roomId) return badRequest("room_id is required")

  await supabase.from("takeoff_marks").delete().eq("takeoff_id", takeoffId).eq("room_id", roomId)
  const { error } = await supabase
    .from("takeoff_rooms").delete().eq("id", roomId).eq("takeoff_id", takeoffId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
