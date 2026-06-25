import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, takeoffExists } from "../../_helpers"

// Editable tag list (matrix rows). Each tag: code, description, color, category.
// spec_number / spec_section_id / unit_cost / vendor_id / vendor_person_id are
// future seams (nullable) — intentionally never written here. POST add, PATCH
// edit/reassign/reorder, DELETE (drops the tag's marks first).

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase, companyId } = ctx
  const { id: takeoffId } = await params
  if (!(await takeoffExists(supabase, takeoffId))) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const code = typeof body.code === "string" ? body.code.trim() : ""
  const color = typeof body.color === "string" ? body.color.trim() : ""
  const description = typeof body.description === "string" ? body.description.trim() || null : null
  const categoryId = typeof body.category_id === "string" && body.category_id ? body.category_id : null
  const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0
  if (!code) return badRequest("code is required")
  if (!color) return badRequest("color is required")

  const { data, error } = await supabase
    .from("takeoff_tags")
    .insert({
      takeoff_id: takeoffId, company_id: companyId, category_id: categoryId,
      code, description, color, sort_order: sortOrder,
    })
    .select("id, takeoff_id, category_id, code, description, color, sort_order").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tag: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params

  const body = await req.json().catch(() => ({}))
  const tagId = typeof body.tag_id === "string" ? body.tag_id : ""
  if (!tagId) return badRequest("tag_id is required")
  const patch: Record<string, unknown> = {}
  if (typeof body.code === "string" && body.code.trim()) patch.code = body.code.trim()
  if (typeof body.color === "string" && body.color.trim()) patch.color = body.color.trim()
  if (typeof body.description === "string") patch.description = body.description.trim() || null
  if ("category_id" in body) patch.category_id = typeof body.category_id === "string" && body.category_id ? body.category_id : null
  if (Number.isFinite(body.sort_order)) patch.sort_order = Number(body.sort_order)
  if (Object.keys(patch).length === 0) return badRequest("nothing to update")

  const { data, error } = await supabase
    .from("takeoff_tags").update(patch)
    .eq("id", tagId).eq("takeoff_id", takeoffId)
    .select("id, takeoff_id, category_id, code, description, color, sort_order").maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ tag: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params
  const tagId = req.nextUrl.searchParams.get("tag_id")
  if (!tagId) return badRequest("tag_id is required")

  await supabase.from("takeoff_marks").delete().eq("takeoff_id", takeoffId).eq("tag_id", tagId)
  const { error } = await supabase
    .from("takeoff_tags").delete().eq("id", tagId).eq("takeoff_id", takeoffId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
