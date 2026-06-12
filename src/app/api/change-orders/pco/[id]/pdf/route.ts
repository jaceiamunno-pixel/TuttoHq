import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildPcoDocuments, type PcoDocData } from "@/lib/pco-pdf"

export const maxDuration = 60

// POST /api/change-orders/pco/[id]/pdf — (re)generate the two PCO documents
// (pricing backup + cover sheet) for a builder PCO. Derived artifacts: stored at
// FIXED paths and overwritten each time ({company_id}/change-orders/{id}/
// backup.pdf | cover.pdf). The DB is the source of truth; a fresh signed URL is
// minted per call so a fixed path is never served stale.
//
// Document assembly is delegated to the pure buildPcoDocuments (src/lib/pco-pdf),
// shared with the import preview so previewed == stored. This route's job is the
// DB read, the asset fetch, and the storage write.
//
// NOTE: imported PCOs are frozen, but PDF regeneration only writes the derived
// pco_backup_pdf_path / pco_cover_pdf_path columns, which the freeze trigger
// allow-lists — so re-generating an imported PCO's documents is permitted.

interface LineItem {
  category: string; description: string | null
  qty_reg: number | null; rate_reg: number | null; qty_ot: number | null; rate_ot: number | null; qty_dt: number | null; rate_dt: number | null
  qty: number | null; unit: string | null; unit_price: number | null; note: string | null; amount: number | null
  sort_order: number | null
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // select("*") (not an explicit list) so this stays resilient if textura_fee
  // (migration 0007) has not been applied yet — a missing column is simply absent.
  const { data: co } = await supabase.from("change_orders")
    .select("*")
    .eq("id", id).maybeSingle()
  if (!co) return NextResponse.json({ error: "Change order not found" }, { status: 404 })
  if (!co.has_pco_detail) return NextResponse.json({ error: "Not a builder PCO" }, { status: 409 })

  const { data: itemsRaw } = await supabase.from("change_order_line_items")
    .select("category, description, qty_reg, rate_reg, qty_ot, rate_ot, qty_dt, rate_dt, qty, unit, unit_price, note, amount, sort_order")
    .eq("change_order_id", id).order("sort_order", { ascending: true })
  const items = (itemsRaw ?? []) as LineItem[]

  // Project + company context
  let project: Record<string, string | null> = {}
  if (co.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", co.project_id).maybeSingle()
    if (p) project = p
  }
  const { data: settings } = await supabase.from("company_settings")
    .select("logo_path, address_line1, address_line2, phone").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }
  // Signature SNAPSHOT taken at save time (change_orders.signer_signature_path),
  // not the live current user — so regeneration by anyone embeds the original
  // signer's signature. Same company → company-assets RLS permits the download.
  let sigBytes: ArrayBuffer | null = null
  if (co.signer_signature_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(co.signer_signature_path)
    if (blob) sigBytes = await blob.arrayBuffer()
  }

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const { data: companyRow } = await supabase.from("companies").select("name").eq("id", companyId).maybeSingle()
  const companyName = companyRow?.name ?? project.gc_name ?? null

  const pcoNum = (co.co_number ?? "").replace(/^CO-/i, "")

  const docData: PcoDocData = {
    pcoNumber: pcoNum,
    jobNumber: project.number ?? null,
    dateISO: co.date ?? null,
    title: co.proposal ?? null,
    descriptionOfWork: co.description_of_work ?? null,
    labor:     items.filter(i => i.category === "labor"),
    materials: items.filter(i => i.category === "material"),
    subs:      items.filter(i => i.category === "subcontractor"),
    ohpPercent: co.oh_p_percent ?? null,
    feePercent: co.fee_percent ?? null,
    texturaFee: co.textura_fee ?? null,
    scheduleImpactDays: co.schedule_impact_days ?? null,
    signerName: co.submitted_by ?? null,
    signerTitle: co.signer_title ?? null,
    projectName: project.name ?? null,
    projectLocation: project.location ?? null,
  }

  const { backup: backupBytes, cover: coverBytes } = await buildPcoDocuments(docData, {
    logoBytes, sigBytes, companyName,
    phone: settings?.phone ?? null,
    addressLine1: settings?.address_line1 ?? null,
    addressLine2: settings?.address_line2 ?? null,
  })

  // ── Store at fixed paths + return fresh signed URLs ──────────────────────────
  const backupPath = `${companyId}/change-orders/${id}/backup.pdf`
  const coverPath  = `${companyId}/change-orders/${id}/cover.pdf`
  const up1 = await supabase.storage.from("submittals").upload(backupPath, Buffer.from(backupBytes), { contentType: "application/pdf", upsert: true })
  const up2 = await supabase.storage.from("submittals").upload(coverPath, Buffer.from(coverBytes), { contentType: "application/pdf", upsert: true })
  if (up1.error || up2.error) {
    console.error("PCO PDF upload failed:", up1.error ?? up2.error)
    return NextResponse.json({ error: "Could not store PDFs" }, { status: 500 })
  }
  await supabase.from("change_orders").update({ pco_backup_pdf_path: backupPath, pco_cover_pdf_path: coverPath }).eq("id", id)

  const { data: bSigned } = await supabase.storage.from("submittals").createSignedUrl(backupPath, 604800)
  const { data: cSigned } = await supabase.storage.from("submittals").createSignedUrl(coverPath, 604800)
  return NextResponse.json({ ok: true, backup_url: bSigned?.signedUrl ?? null, cover_url: cSigned?.signedUrl ?? null })
}
