import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { num } from "@/lib/estimate-server"

// Edit / delete one gc_template_items row (admin-only). RLS is the tenant boundary.
const COLUMNS =
  "id, description, category, default_qty, default_unit, default_unit_cost, sort_order, active, created_at"
const CATEGORIES = ["labor", "material", "subcontractor", "equipment", "other"]

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = {}

  if (typeof body.description === "string") {
    if (!body.description.trim()) return NextResponse.json({ error: "description cannot be empty" }, { status: 400 })
    patch.description = body.description.trim()
  }
  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !CATEGORIES.includes(body.category)) {
      return NextResponse.json({ error: "invalid category" }, { status: 400 })
    }
    patch.category = body.category
  }
  if (body.default_qty !== undefined) patch.default_qty = num(body.default_qty)
  if (body.default_unit !== undefined) {
    patch.default_unit = typeof body.default_unit === "string" && body.default_unit.trim() ? body.default_unit.trim() : null
  }
  if (body.default_unit_cost !== undefined) patch.default_unit_cost = num(body.default_unit_cost)
  if (body.sort_order !== undefined) patch.sort_order = num(body.sort_order) ?? 0
  if (body.active !== undefined) patch.active = !!body.active

  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 })

  const { data, error } = await supabase
    .from("gc_template_items").update(patch).eq("id", id).select(COLUMNS).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ item: data })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const { id } = await params
  const { error } = await supabase.from("gc_template_items").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
