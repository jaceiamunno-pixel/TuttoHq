import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Single supplier-contract detail + edit + delete. Every handler scopes the row
// by id AND type='supplier_contract' so a PO id can never be steered through here,
// and the lookup is RLS-scoped so another company's row comes back null (404).
// Balance numbers come straight from commitment_balances — never recomputed.

function parseValue(raw: unknown): { value: number | null } | { error: string } {
  if (raw == null || raw === "") return { value: null }
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""))
  if (!Number.isFinite(n) || n < 0) return { error: "contract_value must be a non-negative number" }
  return { value: n }
}

// GET /api/supplier-contracts/[id] — the contract + its live balance row.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: contract } = await supabase
    .from("commitments").select("*")
    .eq("id", id).eq("type", "supplier_contract").maybeSingle()
  if (!contract) return NextResponse.json({ error: "Supplier contract not found" }, { status: 404 })

  const { data: balance } = await supabase
    .from("commitment_balances")
    .select("contract_value, released_to_children, contract_remaining")
    .eq("commitment_id", id).maybeSingle()

  return NextResponse.json({ supplier_contract: contract, balance: balance ?? null })
}

// PATCH /api/supplier-contracts/[id] — edit contract fields. A vendor change
// re-snapshots to_company_name and re-checks the supplier/subcontractor role.
// parent_commitment_id is intentionally NOT editable here (a contract has no
// parent); the release-order link is set on the PO side only.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const { data: existing } = await supabase
    .from("commitments").select("id, vendor_id")
    .eq("id", id).eq("type", "supplier_contract").maybeSingle()
  if (!existing) return NextResponse.json({ error: "Supplier contract not found" }, { status: 404 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if ("contract_value" in body) {
    const parsed = parseValue(body.contract_value)
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    update.contract_value = parsed.value
  }
  if (typeof body.cost_code === "string") update.cost_code = body.cost_code.trim() || null
  if (typeof body.terms === "string") update.terms = body.terms.trim() || null
  if (typeof body.notes === "string") update.notes = body.notes.trim() || null

  // Vendor change → resolve through RLS, re-verify role, re-snapshot the name.
  if (typeof body.vendor_id === "string" && body.vendor_id && body.vendor_id !== existing.vendor_id) {
    const { data: vendor } = await supabase
      .from("vendors").select("company_name, is_supplier, is_subcontractor").eq("id", body.vendor_id).maybeSingle()
    if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 400 })
    if (!vendor.is_supplier && !vendor.is_subcontractor) {
      return NextResponse.json({ error: "Vendor must be a supplier or subcontractor" }, { status: 400 })
    }
    update.vendor_id = body.vendor_id
    update.to_company_name = vendor.company_name
  }

  const { data: row, error: upErr } = await supabase
    .from("commitments").update(update)
    .eq("id", id).eq("type", "supplier_contract")
    .select().single()
  if (upErr || !row) return NextResponse.json({ error: upErr?.message ?? "Update failed" }, { status: 500 })

  return NextResponse.json({ supplier_contract: row })
}

// DELETE /api/supplier-contracts/[id] — remove the contract. The FK on
// commitments.parent_commitment_id is ON DELETE SET NULL, so any POs released
// against this contract are NOT deleted — they revert to standalone POs.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: existing } = await supabase
    .from("commitments").select("id")
    .eq("id", id).eq("type", "supplier_contract").maybeSingle()
  if (!existing) return NextResponse.json({ error: "Supplier contract not found" }, { status: 404 })

  const { error: delErr } = await supabase
    .from("commitments").delete().eq("id", id).eq("type", "supplier_contract")
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
