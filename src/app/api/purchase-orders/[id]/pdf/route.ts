import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildPurchaseOrderDocument, type PoDocData } from "@/lib/po-pdf"

export const maxDuration = 60

// POST /api/purchase-orders/[id]/pdf — (re)generate the PO PDF. Mirrors the PCO
// PDF route: DB read + company-asset fetch here, document assembly delegated to
// the pure buildPurchaseOrderDocument. The PDF is stored at a FIXED, deterministic
// path ({companyId}/purchase-orders/{id}/po.pdf) overwritten each call, and a
// fresh signed URL is minted per request so a fixed path is never served stale.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: po } = await supabase
    .from("commitments")
    .select("*")
    .eq("id", id).eq("type", "purchase_order").maybeSingle()
  if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 })

  const { data: lines } = await supabase
    .from("po_line_items")
    .select("quantity, description, unit_price")
    .eq("commitment_id", id)
    .order("line_no", { ascending: true })

  // Vendor block — prefer the live vendor record; fall back to the snapshot name.
  let vendor: Record<string, string | null> = {}
  if (po.vendor_id) {
    const { data: v } = await supabase
      .from("vendors")
      .select("company_name, street_address, city, state, zip_code")
      .eq("id", po.vendor_id).maybeSingle()
    if (v) vendor = v
  }

  // Job block
  let project: Record<string, string | null> = {}
  if (po.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, location").eq("id", po.project_id).maybeSingle()
    if (p) project = p
  }

  // Company identity + logo (same treatment as the PCO documents)
  const { data: settings } = await supabase.from("company_settings")
    .select("logo_path, address_line1, address_line2, phone, logo_scale_pct").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  const { data: companyRow } = await supabase.from("companies").select("name").eq("id", companyId).maybeSingle()

  const docData: PoDocData = {
    poNumber: po.po_number ?? "—",
    dateOrderISO: po.created_at ? String(po.created_at).slice(0, 10) : null,
    dateRequired: po.date_required ?? null,
    terms: po.terms ?? null,
    costCode: po.cost_code ?? null,
    ctTaxTreatment: po.ct_tax_treatment === "included" || po.ct_tax_treatment === "exempt" ? po.ct_tax_treatment : null,
    vendorName: vendor.company_name ?? po.to_company_name ?? null,
    vendorStreet: vendor.street_address ?? null,
    vendorCity: vendor.city ?? null,
    vendorState: vendor.state ?? null,
    vendorZip: vendor.zip_code ?? null,
    projectName: project.name ?? null,
    projectNumber: project.number ?? null,
    projectLocation: project.location ?? null,
    lineItems: (lines ?? []).map(l => ({ quantity: l.quantity, description: l.description, unitPrice: l.unit_price })),
    notes: po.notes ?? null,
  }

  const bytes = await buildPurchaseOrderDocument(docData, {
    logoBytes,
    sigBytes: null,
    companyName: companyRow?.name ?? null,
    phone: settings?.phone ?? null,
    addressLine1: settings?.address_line1 ?? null,
    addressLine2: settings?.address_line2 ?? null,
    logoScalePct: settings?.logo_scale_pct ?? undefined,
  })

  const poPath = `${companyId}/purchase-orders/${id}/po.pdf`
  const up = await supabase.storage.from("submittals").upload(poPath, Buffer.from(bytes), { contentType: "application/pdf", upsert: true })
  if (up.error) {
    console.error("PO PDF upload failed:", up.error)
    return NextResponse.json({ error: "Could not store PDF" }, { status: 500 })
  }

  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(poPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
