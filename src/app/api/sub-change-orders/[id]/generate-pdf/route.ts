import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { computeSubCoRecap } from "@/lib/sub-co-shared"
import { buildSubChangeOrderPdf } from "@/lib/sub-co-pdf"

export const maxDuration = 60

// Generates the Change Order PDF. ALL money comes from computeSubCoRecap()
// (server-side, the single producer) and is frozen into the snap_* columns
// before rendering (PCO stated_* pattern):
//   this_order          = Σ this CO's line prices
//   previous_additions  = prior_additions_override, else Σ positive totals of
//                         OTHER COs, same (project, vendor), status in
//                         (sent, accepted), created_at < this one
//   previous_deductions = prior_deductions_override, else |Σ negative totals|
//   previous_total      = original_contract_amount + additions − deductions
//   present_contract    = previous_total + this_order
// The snapshot records the EFFECTIVE numbers (overrides applied), so the frozen
// snapshot always equals the printed page. The client never computes or
// supplies any of these.

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const { data: sco } = await supabase
    .from("sub_change_orders")
    .select("*")
    .eq("id", id)
    .neq("status", "deleted")
    .maybeSingle()
  if (!sco) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: vendor } = await supabase
    .from("vendors")
    .select("vendor_no, company_name, street_address, city, state, zip_code")
    .eq("id", sco.vendor_id)
    .maybeSingle()
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 })

  const { data: linesRaw } = await supabase
    .from("sub_change_order_lines")
    .select("owner_co_number, gc_co_number, description, cost_code, price, sort_order")
    .eq("sub_change_order_id", id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  const lines = linesRaw ?? []

  // ── Server-side financial snapshot ─────────────────────────────────────────
  const recap = await computeSubCoRecap(supabase, sco)
  const { previousAdditions, previousDeductions, previousTotal, thisOrder, presentContractAmount } = recap

  // Freeze the recap BEFORE rendering, so the stored snapshot and the printed
  // page can never disagree.
  const { error: snapErr } = await supabase
    .from("sub_change_orders")
    .update({
      snap_previous_additions: previousAdditions,
      snap_previous_deductions: previousDeductions,
      snap_previous_total: previousTotal,
      snap_this_order: thisOrder,
      snap_present_contract_amount: presentContractAmount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (snapErr) return NextResponse.json({ error: snapErr.message }, { status: 500 })

  // ── Context: project, company identity, logo, signature snapshot ───────────
  let project: { name: string | null; number: string | null; location: string | null } = {
    name: null, number: null, location: null,
  }
  if (sco.project_id) {
    const { data: p } = await supabase
      .from("projects")
      .select("name, number, location")
      .eq("id", sco.project_id)
      .maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path, logo_scale_pct, address_line1, address_line2, phone, fax")
    .maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }
  let sigBytes: ArrayBuffer | null = null
  if (sco.signer_signature_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(sco.signer_signature_path)
    if (blob) sigBytes = await blob.arrayBuffer()
  }

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  const { data: companyRow } = await supabase.from("companies").select("name").eq("id", companyId).maybeSingle()

  const pdfBytes = await buildSubChangeOrderPdf(
    {
      coNumber: sco.co_number,
      originalContractNo: sco.original_contract_no,
      coDateISO: sco.co_date,
      costCode: sco.cost_code,
      projectName: project.name,
      projectLocation: project.location,
      projectNumber: project.number,
      vendor,
      lines,
      originalContractAmount: sco.original_contract_amount,
      previousAdditions,
      previousDeductions,
      previousTotal,
      thisOrder,
      presentContractAmount,
      signerName: sco.signer_name,
      signerTitle: sco.signer_title,
    },
    {
      logoBytes,
      sigBytes,
      companyName: companyRow?.name ?? null,
      addressLine1: settings?.address_line1 ?? null,
      addressLine2: settings?.address_line2 ?? null,
      phone: settings?.phone ?? null,
      fax: settings?.fax ?? null,
      logoScalePct: settings?.logo_scale_pct ?? undefined,
    },
  )

  // Unique path per generation — avoids Supabase's CDN serving a stale copy.
  // First path segment MUST be the company id (bucket tenant policy).
  const safeNum = String(sco.co_number).replace(/[^\w.-]+/g, "_")
  const pdfPath = `${companyId}/sub-change-orders/${id}/sub_co_${safeNum}_${Date.now()}.pdf`
  const { error: upErr } = await supabase.storage
    .from("submittals")
    .upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  if (upErr) {
    console.error("Sub CO PDF upload failed:", upErr)
    return NextResponse.json({ error: "Could not store PDF" }, { status: 500 })
  }
  await supabase.from("sub_change_orders").update({ generated_pdf_path: pdfPath }).eq("id", id)

  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
