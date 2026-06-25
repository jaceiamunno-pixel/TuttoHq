import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, takeoffExists } from "../../_helpers"

// Editable category list for a takeoff. POST add, PATCH rename/reorder, DELETE.
// company_id is set explicitly on insert (= get_my_company_id(), RLS-validated).

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
    .from("takeoff_categories")
    .insert({ takeoff_id: takeoffId, company_id: companyId, name, sort_order: sortOrder })
    .select("id, takeoff_id, name, sort_order").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ category: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params

  const body = await req.json().catch(() => ({}))
  const categoryId = typeof body.category_id === "string" ? body.category_id : ""
  if (!categoryId) return badRequest("category_id is required")
  const patch: Record<string, unknown> = {}
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim()
  if (Number.isFinite(body.sort_order)) patch.sort_order = Number(body.sort_order)
  if (Object.keys(patch).length === 0) return badRequest("nothing to update")

  const { data, error } = await supabase
    .from("takeoff_categories").update(patch)
    .eq("id", categoryId).eq("takeoff_id", takeoffId)
    .select("id, takeoff_id, name, sort_order").maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ category: data })
}

// DELETE /api/takeoffs/[id]/categories?category_id=…  — blocked when tags still
// reference it (keeps tags/marks intact; category_id may be NOT NULL on the table).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params
  const categoryId = req.nextUrl.searchParams.get("category_id")
  if (!categoryId) return badRequest("category_id is required")

  const { count } = await supabase
    .from("takeoff_tags").select("id", { count: "exact", head: true })
    .eq("takeoff_id", takeoffId).eq("category_id", categoryId)
  if ((count ?? 0) > 0) {
    return NextResponse.json({ error: "Category has tags — move or remove them first" }, { status: 409 })
  }

  const { error } = await supabase
    .from("takeoff_categories").delete().eq("id", categoryId).eq("takeoff_id", takeoffId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
