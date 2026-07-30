import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { normalizeLines, lineTotal, releaseParentError } from "@/lib/po-helpers"

// GET /api/purchase-orders/[id] — one PO with its line items, invoices, and the
// live balance row. The balance comes straight from the commitment_balances view
// (the proven source of truth) — never recomputed here.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  const { data: po } = await supabase
    .from("commitments")
    .select("*")
    .eq("id", id).eq("type", "purchase_order").maybeSingle()
  if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 })

  const { data: lines } = await supabase
    .from("po_line_items")
    .select("id, line_no, quantity, description, unit_price")
    .eq("commitment_id", id)
    .order("line_no", { ascending: true })

  const { data: balance } = await supabase
    .from("commitment_balances")
    .select("contract_value, billed_to_date, remaining_balance, net_paid")
    .eq("commitment_id", id).maybeSingle()

  const { data: invoices } = await supabase
    .from("commitment_invoices")
    .select("id, invoice_no, invoice_date, amount, retainage_amount, status, created_at")
    .eq("commitment_id", id)
    .order("invoice_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })

  return NextResponse.json({ purchase_order: po, line_items: lines ?? [], balance: balance ?? null, invoices: invoices ?? [] })
}

// PATCH /api/purchase-orders/[id] — update fields + replace the line items
// wholesale (delete-then-insert keeps line_no contiguous). Recomputes
// contract_value and re-snapshots the vendor name when the vendor changes.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const { data: existing } = await supabase
    .from("commitments")
    .select("id, project_id, company_id, vendor_id, po_number, status, parent_commitment_id")
    .eq("id", id).eq("type", "purchase_order").maybeSingle()
  if (!existing) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  // PO number is editable (PO rows only — this route already filters type). The
  // company-wide unique index (commitments_company_po_number_uniq, migration
  // 0014) is the real backstop; this app-level check is the friendly fast path
  // that returns a clean 409 before the write. The check is scoped to company_id,
  // not project_id: PO numbers are sequenced per-USER (issue_po_number reads
  // po_prefix/po_next_seq from user_profiles by auth.uid()), POs are company-wide,
  // and RLS scopes commitments to the tenant — so the company is the real
  // namespace for a number. company_id is re-resolved from the row (RLS-scoped),
  // never trusted from the client. The TOCTOU window between this check and the
  // UPDATE is now closed by the index (23505 → 409 below).
  if (typeof body.po_number === "string") {
    const next = body.po_number.trim()
    if (!next) return NextResponse.json({ error: "PO number cannot be empty" }, { status: 400 })
    if (next !== existing.po_number) {
      const { data: clash } = await supabase
        .from("commitments")
        .select("id")
        .eq("type", "purchase_order")
        .eq("company_id", existing.company_id)
        .eq("po_number", next)
        .neq("id", id)
        .limit(1)
        .maybeSingle()
      if (clash) return NextResponse.json({ error: "PO number already in use" }, { status: 409 })
      update.po_number = next
    }
  }

  if (typeof body.project_id === "string" && body.project_id) update.project_id = body.project_id
  if (typeof body.cost_code === "string") update.cost_code = body.cost_code.trim() || null
  if (typeof body.date_required === "string") update.date_required = body.date_required.trim() || null
  if (typeof body.terms === "string") update.terms = body.terms.trim() || null
  if (body.ct_tax_treatment === "included" || body.ct_tax_treatment === "exempt") update.ct_tax_treatment = body.ct_tax_treatment
  else if (body.ct_tax_treatment === null || body.ct_tax_treatment === "") update.ct_tax_treatment = null
  if (typeof body.notes === "string") update.notes = body.notes.trim() || null

  // Lifecycle status — forward progression draft → executed → accepted only.
  // 'accepted' is guarded: a PO that was never issued (no number, still draft)
  // can't be accepted. The accepted date is stored in executed_at (reused; POs
  // have no dedicated accepted_at column and the PDF's order date uses created_at).
  if (typeof body.status === "string") {
    const next = body.status
    if (!["draft", "executed", "accepted"].includes(next)) {
      return NextResponse.json({ error: "Unsupported status" }, { status: 400 })
    }
    if (next === "accepted") {
      if (!existing.po_number) return NextResponse.json({ error: "Issue the PO (it needs a number) before it can be accepted." }, { status: 400 })
      if (existing.status === "draft") return NextResponse.json({ error: "Mark the PO as Issued before accepting it." }, { status: 400 })
      update.status = "accepted"
      update.executed_at = new Date().toISOString().slice(0, 10)  // accepted date
    } else {
      update.status = next
    }
  }

  // Vendor change → re-snapshot the company name into to_company_name.
  if (typeof body.vendor_id === "string" && body.vendor_id && body.vendor_id !== existing.vendor_id) {
    const { data: vendor } = await supabase.from("vendors").select("company_name").eq("id", body.vendor_id).maybeSingle()
    if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 400 })
    update.vendor_id = body.vendor_id
    update.to_company_name = vendor.company_name
  }

  // ── Release-order link (parent supplier_contract) ──────────────────────────
  // Validate against the EFFECTIVE project + vendor for this PO (after any change
  // above), so a link can never end up pointing at a different project/vendor.
  const effProject = (update.project_id as string | undefined) ?? existing.project_id
  const effVendor  = (update.vendor_id as string | undefined) ?? existing.vendor_id
  const projectOrVendorChanged = "project_id" in update || "vendor_id" in update

  // What this write intends the link to be:
  //  • body sends the key → use it (empty/null clears it → standalone)
  //  • body omits it but project/vendor changed and a link exists → re-validate
  //    the existing link so the change can't silently break the invariant
  //  • otherwise → leave the column untouched
  let intendedParent: string | null | undefined
  if ("parent_commitment_id" in body) {
    const raw = typeof body.parent_commitment_id === "string" ? body.parent_commitment_id.trim() : ""
    intendedParent = raw || null
  } else if (existing.parent_commitment_id && projectOrVendorChanged) {
    intendedParent = existing.parent_commitment_id
  }

  if (intendedParent === null) {
    update.parent_commitment_id = null
  } else if (intendedParent) {
    if (!effVendor) return NextResponse.json({ error: "Select a vendor before releasing this PO against a contract." }, { status: 400 })
    const { data: parent } = await supabase
      .from("commitments").select("id, type, project_id, vendor_id").eq("id", intendedParent).maybeSingle()
    if (!parent) return NextResponse.json({ error: "Release-against contract not found or not accessible" }, { status: 400 })
    const reason = releaseParentError(parent, effProject, effVendor)
    if (reason) return NextResponse.json({ error: reason }, { status: 400 })
    update.parent_commitment_id = parent.id
  }

  // Line items: only touch them when the client sends an array.
  if (Array.isArray(body.line_items)) {
    const lines = normalizeLines(body.line_items)
    update.contract_value = lineTotal(lines)

    const { error: delErr } = await supabase.from("po_line_items").delete().eq("commitment_id", id)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
    if (lines.length) {
      const { error: insErr } = await supabase
        .from("po_line_items")
        .insert(lines.map(l => ({ commitment_id: id, ...l })))
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
  }

  const { data: row, error: upErr } = await supabase
    .from("commitments")
    .update(update)
    .eq("id", id)
    .select()
    .single()
  if (upErr || !row) {
    // The unique index can still reject a number that passed the app check above
    // if a concurrent write took it first (TOCTOU). Map it to the same 409.
    if (upErr?.code === "23505") {
      return NextResponse.json({ error: "PO number already in use" }, { status: 409 })
    }
    return NextResponse.json({ error: upErr?.message ?? "Update failed" }, { status: 500 })
  }

  return NextResponse.json({ purchase_order: row })
}

// DELETE /api/purchase-orders/[id] — remove the PO + its line items, then ask
// the sequence to recycle this number (release_po_number is a no-op unless it
// was the last issued).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  const { data: po } = await supabase
    .from("commitments")
    .select("id, po_number")
    .eq("id", id).eq("type", "purchase_order").maybeSingle()
  if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 })

  await supabase.from("po_line_items").delete().eq("commitment_id", id)
  const { error: delErr } = await supabase.from("commitments").delete().eq("id", id)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  if (po.po_number) await supabase.rpc("release_po_number", { p_number: po.po_number })

  return NextResponse.json({ ok: true })
}
