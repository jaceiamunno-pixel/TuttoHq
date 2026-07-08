import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest } from "../_helpers"

// GET /api/takeoffs/[id]  → the full working bundle for one takeoff (categories,
// rooms, tags, marks, page_scales) in one read. RLS scopes every select to the
// caller's company.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id } = await params

  const { data: takeoff } = await supabase
    .from("takeoffs").select("id, project_id, name, created_at").eq("id", id).maybeSingle()
  if (!takeoff) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [categories, rooms, tags, marks, scales] = await Promise.all([
    supabase.from("takeoff_categories").select("id, takeoff_id, name, sort_order")
      .eq("takeoff_id", id).order("sort_order").order("name"),
    supabase.from("takeoff_rooms").select("id, takeoff_id, name, sort_order")
      .eq("takeoff_id", id).order("sort_order").order("name"),
    supabase.from("takeoff_tags").select("id, takeoff_id, category_id, code, description, color, sort_order")
      .eq("takeoff_id", id).order("sort_order").order("code"),
    supabase.from("takeoff_marks").select("id, takeoff_id, tag_id, room_id, source_ref, page, x, y, kind, points, raw_measure")
      .eq("takeoff_id", id),
    supabase.from("takeoff_page_scales").select("id, takeoff_id, source_ref, page, units_per_px, unit, cal_x1, cal_y1, cal_x2, cal_y2")
      .eq("takeoff_id", id),
  ])

  return NextResponse.json({
    takeoff,
    categories: categories.data ?? [],
    rooms: rooms.data ?? [],
    tags: tags.data ?? [],
    marks: marks.data ?? [],
    page_scales: scales.data ?? [],
  })
}

// PATCH /api/takeoffs/[id]  { name }  → rename the takeoff.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id } = await params

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return badRequest("name is required")

  const { data, error } = await supabase
    .from("takeoffs").update({ name }).eq("id", id)
    .select("id, project_id, name, created_at").maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ takeoff: data })
}

// DELETE /api/takeoffs/[id]  → remove a takeoff and everything under it. We clear
// children first (marks → tags → rooms → categories) so the delete can't trip an
// FK regardless of the table's ON DELETE config.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id } = await params

  await supabase.from("takeoff_marks").delete().eq("takeoff_id", id)
  await supabase.from("takeoff_tags").delete().eq("takeoff_id", id)
  await supabase.from("takeoff_rooms").delete().eq("takeoff_id", id)
  await supabase.from("takeoff_categories").delete().eq("takeoff_id", id)
  const { error } = await supabase.from("takeoffs").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
