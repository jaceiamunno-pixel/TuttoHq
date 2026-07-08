import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { ESTIMATE_COLUMNS, LINE_COLUMNS, recalcAndRead } from "@/lib/estimate-server"

// One estimate: header + lines (GET), header/param edits (PATCH), delete (DELETE).
// RLS is the tenant boundary on every query. PATCH allow-lists the mutable header
// fields, then recalculate_estimate() reprices — a param change (fee/burden/bond/
// tax/permit/sqft) MUST flow through the server function, never a client sum.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: estimate, error } = await supabase
    .from("estimates").select(ESTIMATE_COLUMNS).eq("id", id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!estimate) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: lines, error: lErr } = await supabase
    .from("estimate_lines")
    .select(LINE_COLUMNS)
    .eq("estimate_id", id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })

  return NextResponse.json({ estimate, lines: lines ?? [] })
}

// Mutable header fields. Percentages arrive as fractions (the client converts its
// percent inputs ÷100 before sending, matching the PCO builder). All are applied
// verbatim; recalculate_estimate() does every dollar computation downstream.
const ALLOWED = [
  "name", "status",
  "overhead_pct", "profit_pct", "fee_pct", "labor_burden_pct",
  "material_tax_exempt", "equip_material_tax_rate", "bond_pct",
  "permit_amount", "sqft",
] as const

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => (ALLOWED as readonly string[]).includes(k)),
  )
  if (Object.keys(safe).length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 })
  safe.updated_at = new Date().toISOString()

  const { error } = await supabase.from("estimates").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { estimate, error: rErr } = await recalcAndRead(supabase, id)
  if (rErr) return NextResponse.json({ error: rErr }, { status: 500 })
  return NextResponse.json({ estimate })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("estimates").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // estimate_lines cascade via FK ON DELETE CASCADE (migration 0029).
  const { error } = await supabase.from("estimates").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
