import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { normalizeLines, lineTotal } from "@/lib/po-helpers"

// Purchase Orders = commitments rows with type = 'purchase_order'. POs are
// company-wide (RLS scopes to the tenant); subcontract-type commitments are not
// surfaced here yet.

// GET /api/purchase-orders — newest first, company-wide.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("commitments")
    .select("*")
    .eq("type", "purchase_order")
    .order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ purchase_orders: data ?? [] })
}

// POST /api/purchase-orders — create a draft PO. The PO number is issued here,
// server-side, via issue_po_number() — never supplied or trusted from the client.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const project_id = typeof body.project_id === "string" ? body.project_id : ""
  const vendor_id = typeof body.vendor_id === "string" ? body.vendor_id : ""

  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!vendor_id) return NextResponse.json({ error: "vendor_id is required" }, { status: 400 })

  // Snapshot the vendor's company name into to_company_name (NOT NULL) so the PO
  // record carries its own copy even if the vendor master later changes.
  const { data: vendor } = await supabase.from("vendors").select("company_name").eq("id", vendor_id).maybeSingle()
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 400 })

  const lines = normalizeLines(body.line_items)

  // Issue the PO number SERVER-SIDE — this is the single authoritative source of
  // the number. issue_po_number() reads the caller's po_prefix/po_next_seq from
  // user_profiles and increments it atomically; we never trust a client value.
  const { data: issued, error: numErr } = await supabase.rpc("issue_po_number")
  if (numErr || !issued) {
    // Surface the RPC's own message (e.g. "PO numbering not configured for this
    // user") so the cause is actionable rather than a generic field error.
    const msg = numErr?.message ?? "Could not issue a PO number"
    return NextResponse.json({ error: msg }, { status: /not configured/i.test(msg) ? 400 : 500 })
  }
  const po_number = issued as string

  const { data: row, error: insertError } = await supabase
    .from("commitments")
    .insert({
      type: "purchase_order",
      status: "draft",
      project_id,
      vendor_id,
      to_company_name: vendor.company_name,
      po_number,
      cost_code: typeof body.cost_code === "string" ? body.cost_code.trim() || null : null,
      date_required: typeof body.date_required === "string" ? body.date_required.trim() || null : null,
      terms: typeof body.terms === "string" ? body.terms.trim() || null : null,
      ct_tax_treatment: body.ct_tax_treatment === "included" || body.ct_tax_treatment === "exempt" ? body.ct_tax_treatment : null,
      notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
      contract_value: lineTotal(lines),
      uploaded_by: user.id,
    })
    .select()
    .single()

  if (insertError || !row) {
    // The number was already consumed by the RPC; recycle it if it was the last
    // issued so the sequence doesn't skip on a failed insert.
    await supabase.rpc("release_po_number", { p_number: po_number })
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
  }

  if (lines.length) {
    const { error: liError } = await supabase
      .from("po_line_items")
      .insert(lines.map(l => ({ commitment_id: row.id, ...l })))
    if (liError) return NextResponse.json({ error: liError.message }, { status: 500 })
  }

  return NextResponse.json({ purchase_order: row }, { status: 201 })
}
