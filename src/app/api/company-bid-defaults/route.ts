import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// company_bid_defaults — one row per company (ADR-015). The tenant's OWN bid
// parameters. GENERAL-SOFTWARE RULE: only the "10-10 rule" (overhead 10% / profit
// 10%) has an industry default; burden / tax rate / bond have no national default
// and ship NULL ("not set"), never 0. A generated estimate SNAPSHOTS these values,
// so editing them here never reprices an existing bid.
//
// Reads are open to any company member (the generate flow reads them server-side
// anyway); writes are admin-only. Upsert = read-then-update-or-insert (RLS scopes
// the SELECT to this tenant, so a found row is guaranteed the right one — the same
// pattern as /api/settings/reminders).

const COLUMNS =
  "id, overhead_pct, profit_pct, labor_burden_pct, material_tax_exempt, equip_material_tax_rate, bond_pct, permit_basis_note, updated_at"

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase.from("company_bid_defaults").select(COLUMNS).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ defaults: data ?? null })
}

// Fraction in [0, 100] (a bond of 200% is a typo, not a bid). Empty/null → null.
// Returns { ok, value } so a bad input is a 400, not a silently-coerced 0.
function pct(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false }
  return { ok: true, value: n }
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  // overhead / profit are NOT NULL — empty falls back to the 10-10 rule, never a
  // null write. The nullable ones (burden / tax rate / bond) pass null through.
  const oh = pct(body.overhead_pct)
  const profit = pct(body.profit_pct)
  const burden = pct(body.labor_burden_pct)
  const taxRate = pct(body.equip_material_tax_rate)
  const bond = pct(body.bond_pct)
  if (!oh.ok || !profit.ok || !burden.ok || !taxRate.ok || !bond.ok) {
    return NextResponse.json({ error: "percentages must be between 0 and 100" }, { status: 400 })
  }

  const values = {
    overhead_pct: oh.value ?? 0.1,
    profit_pct: profit.value ?? 0.1,
    labor_burden_pct: burden.value,
    material_tax_exempt: body.material_tax_exempt === undefined ? true : !!body.material_tax_exempt,
    equip_material_tax_rate: taxRate.value,
    bond_pct: bond.value,
    permit_basis_note:
      typeof body.permit_basis_note === "string" && body.permit_basis_note.trim()
        ? body.permit_basis_note.trim()
        : null,
    updated_at: new Date().toISOString(),
  }

  const { data: existing } = await supabase.from("company_bid_defaults").select("id").maybeSingle()
  if (existing) {
    const { error } = await supabase.from("company_bid_defaults").update(values).eq("id", existing.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
    if (cErr || !companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
    const { error } = await supabase.from("company_bid_defaults").insert({ company_id: companyId, ...values })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data } = await supabase.from("company_bid_defaults").select(COLUMNS).maybeSingle()
  return NextResponse.json({ ok: true, defaults: data ?? null })
}
