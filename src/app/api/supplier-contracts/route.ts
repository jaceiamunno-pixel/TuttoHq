import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Supplier Contracts = commitments rows with type = 'supplier_contract'. A
// contract is the PARENT a purchase_order is released against. Its drawdown
// (released_to_children / contract_remaining) is owned by the commitment_balances
// view — this route never recomputes money, it only attaches the view's numbers.
//
// Tenant isolation is server-authoritative: every read/write goes through the
// RLS-scoped server client, and the vendor + project are resolved through
// RLS-scoped lookups (a row that isn't visible to the caller's company comes
// back null and the write is rejected) — not trusted from the client.

// Parse a money-ish string|number into a finite, non-negative number or null.
// Returns the sentinel { error } when the input is present but invalid.
function parseValue(raw: unknown): { value: number | null } | { error: string } {
  if (raw == null || raw === "") return { value: null }
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""))
  if (!Number.isFinite(n) || n < 0) return { error: "contract_value must be a non-negative number" }
  return { value: n }
}

// GET /api/supplier-contracts?project_id=…&vendor_id=… — supplier contracts for a
// project (newest first), each carrying released_to_children + contract_remaining
// from the balances view. vendor_id is an optional narrow (used by the PO
// release-against-contract picker to list only the matching vendor's contracts).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get("project_id")?.trim() ?? ""
  const vendorId = req.nextUrl.searchParams.get("vendor_id")?.trim() ?? ""
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  let q = supabase
    .from("commitments")
    .select("*")
    .eq("type", "supplier_contract")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  if (vendorId) q = q.eq("vendor_id", vendorId)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Attach drawdown straight from commitment_balances (source of truth). Scoped
  // by project + type; merged by id. No summing on this side.
  const { data: balances } = await supabase
    .from("commitment_balances")
    .select("commitment_id, contract_value, released_to_children, contract_remaining")
    .eq("type", "supplier_contract")
    .eq("project_id", projectId)
  const byId = new Map((balances ?? []).map(b => [b.commitment_id, b]))
  const rows = (data ?? []).map(c => {
    const b = byId.get(c.id)
    return {
      ...c,
      contract_value: b?.contract_value ?? c.contract_value,
      released_to_children: b?.released_to_children ?? 0,
      contract_remaining: b?.contract_remaining ?? c.contract_value ?? 0,
    }
  })
  return NextResponse.json({ supplier_contracts: rows })
}

// POST /api/supplier-contracts — create a supplier contract. parent_commitment_id
// is forced null in code (a contract can never have a parent; the DB
// commitments_parent_rules CHECK enforces the same, this is defense-in-depth).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const project_id = typeof body.project_id === "string" ? body.project_id.trim() : ""
  const vendor_id  = typeof body.vendor_id === "string" ? body.vendor_id.trim() : ""
  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!vendor_id)  return NextResponse.json({ error: "vendor_id is required" }, { status: 400 })

  // Tenant isolation: confirm the project is visible to this company via RLS. A
  // row that isn't comes back null → reject (don't let a client point a contract
  // at another tenant's project).
  const { data: project } = await supabase.from("projects").select("id").eq("id", project_id).maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 400 })

  // Resolve the vendor through RLS and verify it is a supplier or subcontractor.
  // The company name is snapshotted into to_company_name (NOT NULL) so the
  // contract keeps its own copy even if the vendor master later changes.
  const { data: vendor } = await supabase
    .from("vendors").select("company_name, is_supplier, is_subcontractor").eq("id", vendor_id).maybeSingle()
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 400 })
  if (!vendor.is_supplier && !vendor.is_subcontractor) {
    return NextResponse.json({ error: "Vendor must be a supplier or subcontractor" }, { status: 400 })
  }

  const parsed = parseValue(body.contract_value)
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data: row, error: insertError } = await supabase
    .from("commitments")
    .insert({
      type: "supplier_contract",
      status: "executed",
      project_id,
      vendor_id,
      to_company_name: vendor.company_name,
      contract_value: parsed.value,
      cost_code: typeof body.cost_code === "string" ? body.cost_code.trim() || null : null,
      terms: typeof body.terms === "string" ? body.terms.trim() || null : null,
      notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
      parent_commitment_id: null,  // a contract is never a child
      uploaded_by: user.id,
    })
    .select()
    .single()

  if (insertError || !row) {
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
  }
  return NextResponse.json({ supplier_contract: row }, { status: 201 })
}
