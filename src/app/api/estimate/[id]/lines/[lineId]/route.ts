import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { LINE_COLUMNS, recalcAndRead } from "@/lib/estimate-server"

// Edit or delete one estimate_line, then reprice via recalculate_estimate() and
// return the fresh header totals. RLS is the tenant boundary; the .eq on both
// line id and estimate_id keeps a line scoped to its estimate. Line inputs are
// stored verbatim — all dollar math is downstream in the server function.

const LINE_FIELDS = [
  "cost_code", "spec_number", "description", "category", "sort_order",
  "qty_reg", "rate_reg", "qty_ot", "rate_ot", "qty_dt", "rate_dt",
  "material_qty", "material_unit", "material_unit_price", "amount",
] as const

const CATEGORIES = ["labor", "material", "subcontractor", "equipment", "other"]

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, lineId } = await params
  const updates = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => (LINE_FIELDS as readonly string[]).includes(k)),
  )
  if (safe.category !== undefined && !CATEGORIES.includes(String(safe.category))) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 })
  }
  if (Object.keys(safe).length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 })

  const { data: line, error } = await supabase
    .from("estimate_lines")
    .update(safe)
    .eq("id", lineId)
    .eq("estimate_id", id)
    .select(LINE_COLUMNS)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!line) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { estimate, error: rErr } = await recalcAndRead(supabase, id)
  if (rErr) return NextResponse.json({ error: rErr }, { status: 500 })
  return NextResponse.json({ line, estimate })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, lineId } = await params
  const { error } = await supabase
    .from("estimate_lines").delete().eq("id", lineId).eq("estimate_id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { estimate, error: rErr } = await recalcAndRead(supabase, id)
  if (rErr) return NextResponse.json({ error: rErr }, { status: 500 })
  return NextResponse.json({ estimate })
}
