import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"
import { computePcoTotals, laborLineTotal, materialLineTotal,
         type PcoLaborLine, type PcoMaterialLine, type PcoSubLine } from "@/app/dashboard/_shared/pco-math"

export const maxDuration = 60

// POST /api/change-orders/pco/[id]/pdf — (re)generate the two PCO documents
// (pricing backup + cover sheet) for a builder PCO. Derived artifacts: stored at
// FIXED paths and overwritten each time ({company_id}/change-orders/{id}/
// backup.pdf | cover.pdf). The DB is the source of truth; a fresh signed URL is
// minted per call so a fixed path is never served stale.
//
// Totals are recomputed from the stored line items via the shared computePcoTotals,
// so the documents always reconcile with the log's pricing_sum.

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const hrs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
const n0 = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

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

  const { data: co } = await supabase.from("change_orders")
    .select("id, co_number, project_id, date, proposal, description_of_work, schedule_impact_days, oh_p_percent, submitted_by, signer_title, signer_signature_path, has_pco_detail")
    .eq("id", id).maybeSingle()
  if (!co) return NextResponse.json({ error: "Change order not found" }, { status: 404 })
  if (!co.has_pco_detail) return NextResponse.json({ error: "Not a builder PCO" }, { status: 409 })

  const { data: itemsRaw } = await supabase.from("change_order_line_items")
    .select("category, description, qty_reg, rate_reg, qty_ot, rate_ot, qty_dt, rate_dt, qty, unit, unit_price, note, amount, sort_order")
    .eq("change_order_id", id).order("sort_order", { ascending: true })
  const items = (itemsRaw ?? []) as LineItem[]

  const laborRows   = items.filter(i => i.category === "labor")
  const materialRows = items.filter(i => i.category === "material")
  const subRows     = items.filter(i => i.category === "subcontractor")

  const laborInputs: PcoLaborLine[] = laborRows.map(l => ({ qty_reg: l.qty_reg, rate_reg: l.rate_reg, qty_ot: l.qty_ot, rate_ot: l.rate_ot, qty_dt: l.qty_dt, rate_dt: l.rate_dt }))
  const materialInputs: PcoMaterialLine[] = materialRows.map(m => ({ qty: m.qty, unit_price: m.unit_price }))
  const subInputs: PcoSubLine[] = subRows.map(s => ({ amount: s.amount }))
  const totals = computePcoTotals(laborInputs, materialInputs, subInputs, co.oh_p_percent)

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

  const pcoLabel = `PCO ${(co.co_number ?? "").replace(/^CO-/i, "")}`
  const dateLong = co.date ? new Date(co.date + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : ""

  // ── Backup PDF ──────────────────────────────────────────────────────────────
  const backup = await PDFBuilder.create({ documentType: "PCO Pricing Backup", documentNumber: pcoLabel, logoBytes })
  backup.fieldGrid([[
    { label: "PCO #", value: (co.co_number ?? "").replace(/^CO-/i, "") },
    { label: "Job #", value: project.number },
    { label: "Date", value: dateLong },
  ]])

  const ohpPct = +(Number(co.oh_p_percent ?? 0) * 100).toFixed(4)

  // LABOR — one row per line item, separate qty/rate columns per tier. Rates are
  // the snapshotted line-item values (never live labor_rates).
  backup.sectionDivider("Labor")
  const laborDisplay = laborRows.filter(l => laborLineTotal(l) !== 0 || [l.qty_reg, l.qty_ot, l.qty_dt].some(q => n0(q) !== 0))
  if (laborDisplay.length) {
    const cols = [118, 48, 58, 48, 58, 48, 58, 90]
    const rows = laborDisplay.map(l => [
      l.description ?? "—",
      hrs(n0(l.qty_reg)), usd(n0(l.rate_reg)),
      hrs(n0(l.qty_ot)),  usd(n0(l.rate_ot)),
      hrs(n0(l.qty_dt)),  usd(n0(l.rate_dt)),
      usd(laborLineTotal(l)),
    ])
    rows.push(["Subtotal", hrs(totals.hoursReg), "", hrs(totals.hoursOt), "", hrs(totals.hoursDt), "", usd(totals.laborSubtotal)])
    backup.table(["Role", "Reg qty", "Reg rate", "1.5× qty", "1.5× rate", "2× qty", "2× rate", "Total"], rows, cols, r => r[0] === "Subtotal")
  } else {
    backup.paragraph("—", { muted: true })
  }

  // MATERIAL / EQUIPMENT
  backup.sectionDivider("Material / Equipment")
  const matDisplay = materialRows.filter(m => materialLineTotal(m) !== 0 || (m.description ?? "").trim() !== "")
  if (matDisplay.length) {
    const cols = [168, 50, 48, 86, 96, 78]
    const rows = matDisplay.map(m => [
      m.description ?? "—", hrs(n0(m.qty)), m.unit ?? "", usd(n0(m.unit_price)), m.note ?? "", usd(materialLineTotal(m)),
    ])
    rows.push(["Materials Subtotal", "", "", "", "", usd(totals.materialsSubtotal)])
    backup.table(["Description", "Qty", "Unit", "Unit price", "Note", "Total"], rows, cols, r => r[0] === "Materials Subtotal")
  } else {
    backup.paragraph("—", { muted: true })
  }

  // SUBCONTRACTOR
  backup.sectionDivider("Subcontractor")
  const subDisplay = subRows.filter(s => n0(s.amount) !== 0 || (s.description ?? "").trim() !== "")
  if (subDisplay.length) {
    const cols = [430, 96]
    const rows = subDisplay.map(s => [s.description ?? "—", usd(n0(s.amount))])
    rows.push(["Subcontractor Total", usd(totals.subSubtotal)])
    backup.table(["Name", "Amount"], rows, cols, r => r[0] === "Subcontractor Total")
  } else {
    backup.paragraph("—", { muted: true })
  }

  // SUMMARY — OH&P shows the percent applied (to labor + materials only).
  backup.sectionDivider("Summary")
  backup.fieldGrid([
    [{ label: "Labor", value: usd(totals.laborSubtotal) }],
    [{ label: "Material / Equipment", value: usd(totals.materialsSubtotal) }],
    [{ label: `OH&P (${ohpPct}%)`, value: usd(totals.ohpAmount) }],
    [{ label: "Subcontractor", value: usd(totals.subSubtotal) }],
  ])
  backup.pricingBlock(usd(totals.grandTotal), false)
  const backupBytes = await backup.save()

  // ── Cover PDF ───────────────────────────────────────────────────────────────
  const cover = await PDFBuilder.create({ documentType: "Proposed Change Order", documentNumber: pcoLabel, logoBytes, brandName: project.gc_name })
  // Letterhead: company address right-aligned under the logo (which the header
  // draws top-right).
  const addr = [settings?.address_line1, settings?.address_line2, settings?.phone].filter(Boolean).join("\n")
  if (addr) cover.paragraph(addr, { size: 9, muted: true, align: "right", gap: 8 })

  if (project.name || project.number) {
    cover.projectBlock({ name: project.name, number: project.number, location: project.location, gc_name: project.gc_name, architect: project.architect })
  }
  cover.fieldGrid([[{ label: "PCO #", value: (co.co_number ?? "").replace(/^CO-/i, "") }, { label: "Date", value: dateLong }]])

  if (co.proposal) cover.paragraph(co.proposal, { bold: true, size: 12, gap: 6 })
  cover.textBlock("Description of Work", co.description_of_work)

  // Pricing Summary — all five lines always (Labor / M&E / OH&P / Subcontractor
  // / TOTAL). TOTAL == saved pricing_sum since both come from computePcoTotals.
  cover.sectionDivider("Pricing Summary")
  cover.fieldGrid([
    [{ label: "Labor", value: usd(totals.laborSubtotal) }],
    [{ label: "Material & Equipment", value: usd(totals.materialsSubtotal) }],
    [{ label: `OH&P (${ohpPct}%)`, value: usd(totals.ohpAmount) }],
    [{ label: "Subcontractor", value: usd(totals.subSubtotal) }],
  ])
  cover.pricingBlock(usd(totals.grandTotal), false)

  const days = co.schedule_impact_days ?? 0
  const schedSentence = days === 0
    ? "As a result of this PCO the project schedule will not be impacted."
    : `As a result of this PCO the project schedule will be ${days > 0 ? "increased" : "decreased"} by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}.`
  cover.spacer(6)
  cover.paragraph(schedSentence, { gap: 12 })

  // Never print an email as the signer name (submitted_by can default from the
  // auth identity). Suppress anything that looks like an email address.
  const signerName = co.submitted_by && !/\S+@\S+\.\S+/.test(co.submitted_by) ? co.submitted_by : ""
  cover.paragraph("Sincerely,", { gap: 4 })
  if (sigBytes) await cover.image(sigBytes, { maxH: 46, maxW: 200 })
  cover.paragraph(signerName, { bold: true, gap: 1 })
  cover.paragraph(co.signer_title ?? "", { muted: true })
  const coverBytes = await cover.save()

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
