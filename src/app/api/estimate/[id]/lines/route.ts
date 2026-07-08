import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { LINE_COLUMNS, recalcAndRead } from "@/lib/estimate-server"

// Add an estimate_line, then reprice via recalculate_estimate() and return both
// the new line and the fresh header totals so the editor updates the bid stack
// from the server snapshot (never a client sum). company_id + estimate_id are
// stamped explicitly; RLS WITH CHECK enforces the tenant.

// Line fields a client may set. Money math never happens here — these are raw
// inputs; recalculate_estimate() extends and rolls them up.
const LINE_FIELDS = [
  "cost_code", "spec_number", "description", "category", "source", "sort_order",
  "qty_reg", "rate_reg", "qty_ot", "rate_ot", "qty_dt", "rate_dt",
  "material_qty", "material_unit", "material_unit_price", "amount",
] as const

const CATEGORIES = ["labor", "material", "subcontractor", "equipment", "other"]
const SOURCES = ["spec_book", "takeoff", "gc_template", "manual"]

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Verify the estimate exists + is visible to this tenant (RLS-scoped) before
  // inserting a child row.
  const { data: est, error: selErr } = await supabase
    .from("estimates").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!est) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const row: Record<string, unknown> = Object.fromEntries(
    Object.entries(body).filter(([k]) => (LINE_FIELDS as readonly string[]).includes(k)),
  )
  if (row.category !== undefined && !CATEGORIES.includes(String(row.category))) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 })
  }
  if (row.source !== undefined && !SOURCES.includes(String(row.source))) {
    return NextResponse.json({ error: "invalid source" }, { status: 400 })
  }
  row.estimate_id = id
  row.company_id = companyId
  if (row.source === undefined) row.source = "manual"
  if (row.category === undefined) row.category = "other"

  const { data: line, error } = await supabase
    .from("estimate_lines").insert(row).select(LINE_COLUMNS).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { estimate, error: rErr } = await recalcAndRead(supabase, id)
  if (rErr) return NextResponse.json({ error: rErr }, { status: 500 })
  return NextResponse.json({ line, estimate })
}
