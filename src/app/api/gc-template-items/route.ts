import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { num } from "@/lib/estimate-server"

// gc_template_items — the company's reusable general-conditions block (ADR-015).
// Ships EMPTY; each tenant builds its own once during setup. The generate-from-
// spec scaffold copies the active rows into a new estimate as source='gc_template'
// lines. Reads are open to any company member; writes are admin-only. company_id
// is stamped explicitly on insert (defense-in-depth over the column DEFAULT + RLS).

const COLUMNS =
  "id, description, category, default_qty, default_unit, default_unit_cost, sort_order, active, created_at"
const CATEGORIES = ["labor", "material", "subcontractor", "equipment", "other"]

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("gc_template_items")
    .select(COLUMNS)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("description", { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const description = typeof body.description === "string" ? body.description.trim() : ""
  if (!description) return NextResponse.json({ error: "description is required" }, { status: 400 })
  const category = typeof body.category === "string" && CATEGORIES.includes(body.category) ? body.category : "other"

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const { data, error } = await supabase
    .from("gc_template_items")
    .insert({
      company_id: companyId,
      description,
      category,
      default_qty: num(body.default_qty),
      default_unit: typeof body.default_unit === "string" && body.default_unit.trim() ? body.default_unit.trim() : null,
      default_unit_cost: num(body.default_unit_cost),
      sort_order: num(body.sort_order) ?? 0,
      active: body.active === undefined ? true : !!body.active,
    })
    .select(COLUMNS)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data }, { status: 201 })
}
