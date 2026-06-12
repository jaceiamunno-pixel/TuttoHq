// Pure PCO document builder — the backup (pricing worksheet) + cover (letter)
// PDFs, assembled from a PLAIN data object with NO database access. Both the
// stored-PDF route (/api/change-orders/pco/[id]/pdf) and the import review's
// no-store preview render through this one function, so a previewed-before-
// commit document is byte-identical to what gets stored on commit.
//
// Totals are recomputed here via the shared computePcoTotals, so the documents
// always reconcile with the log's pricing_sum (which is the same computation).

import { PDFBuilder, PDF } from "@/lib/pdf-builder"
import {
  computePcoTotals, laborLineTotal, materialLineTotal,
  type PcoLaborLine, type PcoMaterialLine, type PcoSubLine,
} from "@/app/dashboard/_shared/pco-math"

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const hrs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
const n0 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export interface PcoDocLabor extends PcoLaborLine { description: string | null }
export interface PcoDocMaterial extends PcoMaterialLine { description: string | null; unit: string | null; note: string | null }
export interface PcoDocSub extends PcoSubLine { description: string | null }

// Everything the two documents need, with no DB row required. ohpPercent /
// feePercent are FRACTIONS (0.15 == 15%), matching change_orders columns and
// computePcoTotals.
export interface PcoDocData {
  pcoNumber: string                 // display number, e.g. "042"
  jobNumber: string | null
  dateISO: string | null            // 'YYYY-MM-DD'
  title: string | null              // proposal / cover title
  descriptionOfWork: string | null
  labor: PcoDocLabor[]
  materials: PcoDocMaterial[]
  subs: PcoDocSub[]
  ohpPercent: number | null
  feePercent: number | null
  scheduleImpactDays: number | null
  signerName: string | null
  signerTitle: string | null
  projectName: string | null
  projectLocation: string | null
}

export interface PcoDocAssets {
  logoBytes: ArrayBuffer | null
  sigBytes: ArrayBuffer | null
  companyName: string | null
  phone: string | null
}

function fmtDateLong(dateISO: string | null): string {
  if (!dateISO) return ""
  try { return new Date(dateISO + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) }
  catch { return dateISO }
}

export async function buildPcoDocuments(
  data: PcoDocData,
  assets: PcoDocAssets,
): Promise<{ backup: Uint8Array; cover: Uint8Array }> {
  const { logoBytes, sigBytes, companyName, phone } = assets

  const laborInputs: PcoLaborLine[] = data.labor.map(l => ({ qty_reg: l.qty_reg, rate_reg: l.rate_reg, qty_ot: l.qty_ot, rate_ot: l.rate_ot, qty_dt: l.qty_dt, rate_dt: l.rate_dt }))
  const materialInputs: PcoMaterialLine[] = data.materials.map(m => ({ qty: m.qty, unit_price: m.unit_price }))
  const subInputs: PcoSubLine[] = data.subs.map(s => ({ amount: s.amount }))
  const totals = computePcoTotals(laborInputs, materialInputs, subInputs, data.ohpPercent, data.feePercent)

  const dateLong = fmtDateLong(data.dateISO)
  const ohpPct = +(Number(data.ohpPercent ?? 0) * 100).toFixed(4)
  const feePct = +(Number(data.feePercent ?? 0) * 100).toFixed(4)
  const pcoLabel = `PCO ${data.pcoNumber}`

  // ── Backup PDF — THP-style full-grid worksheet ──────────────────────────────
  const backup = await PDFBuilder.create({ documentType: "PCO Pricing Backup", documentNumber: pcoLabel, logoBytes })
  backup.fieldGrid([[
    { label: "PCO #", value: data.pcoNumber },
    { label: "Job #", value: data.jobNumber },
    { label: "Date", value: dateLong },
  ]])

  // LABOR — full snapshotted roster (every saved line incl. 0-qty). Rates are snapshots.
  backup.sectionDivider("Labor")
  if (data.labor.length) {
    const cols = [110, 38, 34, 58, 38, 58, 38, 58, 94]
    const align: ("left" | "right")[] = ["left", "right", "left", "right", "right", "right", "right", "right", "right"]
    const rows = data.labor.map(l => [
      l.description ?? "—",
      hrs(n0(l.qty_reg)), "hrs", usd(n0(l.rate_reg)),
      hrs(n0(l.qty_ot)),  usd(n0(l.rate_ot)),
      hrs(n0(l.qty_dt)),  usd(n0(l.rate_dt)),
      usd(laborLineTotal(l)),
    ])
    rows.push(["Total Hours", hrs(totals.hoursReg), "", "", hrs(totals.hoursOt), "", hrs(totals.hoursDt), "", ""])
    rows.push(["Labor Subtotal", "", "", "", "", "", "", "", usd(totals.laborSubtotal)])
    backup.gridTable(["Labor", "Qty", "Unit", "Reg Rate", "Qty", "1.5× Rate", "Qty", "2× Rate", "Total"], rows, cols,
      { align, highlight: r => r[0] === "Labor Subtotal" })
  } else {
    backup.paragraph("—", { muted: true })
  }

  // MATERIAL / EQUIPMENT
  backup.sectionDivider("Material / Equipment")
  if (data.materials.length) {
    const cols = [150, 44, 44, 80, 124, 84]
    const align: ("left" | "right")[] = ["left", "right", "left", "right", "left", "right"]
    const rows = data.materials.map(m => [
      m.description ?? "—", hrs(n0(m.qty)), m.unit ?? "", usd(n0(m.unit_price)), m.note ?? "", usd(materialLineTotal(m)),
    ])
    rows.push(["Materials Subtotal", "", "", "", "", usd(totals.materialsSubtotal)])
    backup.gridTable(["Material / Equipment", "Qty", "Unit", "Unit Price", "Note", "Total"], rows, cols,
      { align, highlight: r => r[0] === "Materials Subtotal" })
  } else {
    backup.paragraph("—", { muted: true })
  }

  // SUBCONTRACTOR
  backup.sectionDivider("Subcontractor")
  if (data.subs.length) {
    const cols = [442, 84]
    const align: ("left" | "right")[] = ["left", "right"]
    const rows = data.subs.map(s => [s.description ?? "—", usd(n0(s.amount))])
    rows.push(["Subcontractor Subtotal", usd(totals.subSubtotal)])
    backup.gridTable(["Name", "Amount"], rows, cols, { align, highlight: r => r[0] === "Subcontractor Subtotal" })
  } else {
    backup.paragraph("—", { muted: true })
  }

  // OH&P + GRAND TOTAL (pre-fee) + Fee. Backup Grand Total EXCLUDES the fee.
  backup.spacer(2)
  backup.gridTable([], [
    [`OH&P (${ohpPct}%)`, usd(totals.ohpAmount)],
    ["Grand Total", usd(totals.preFeeTotal)],
    [`Fee (${feePct}%)`, usd(totals.feeAmount)],
  ], [442, 84], { align: ["left", "right"], highlight: () => true })
  const backupBytes = await backup.save()

  // ── Cover PDF — THP-style letterhead letter ─────────────────────────────────
  const cover = await PDFBuilder.create({ documentType: "", noHeader: true })
  await cover.letterhead({ logoBytes, companyName, phone })

  cover.letterField("Date", dateLong)
  cover.letterField("Project", [data.projectName, data.projectLocation].filter(Boolean).join("\n"))
  cover.letterField("PCO #", data.pcoNumber)
  cover.letterField("Title", data.title)

  if (data.descriptionOfWork && data.descriptionOfWork.trim()) {
    cover.paragraph("Description of Work:", { bold: true, size: PDF.size.label, gap: 3 })
    cover.paragraph(data.descriptionOfWork, { gap: 12 })
  }

  // Pricing summary — TOTAL highlighted and == pricing_sum (both from computePcoTotals).
  cover.paragraph("Pricing Summary:", { bold: true, size: PDF.size.label, gap: 4 })
  cover.gridTable([], [
    ["Labor", usd(totals.laborSubtotal)],
    ["Material & Equipment", usd(totals.materialsSubtotal)],
    [`OH&P (${ohpPct}%)`, usd(totals.ohpAmount)],
    ["Subcontractor", usd(totals.subSubtotal)],
    [`Fee (${feePct}%)`, usd(totals.feeAmount)],
    ["TOTAL", usd(totals.grandTotal)],
  ], [400, 126], { align: ["left", "right"], highlight: r => r[0] === "TOTAL" })

  const days = data.scheduleImpactDays ?? 0
  const schedSentence = days === 0
    ? "As a result of this PCO the project schedule will not be impacted."
    : `As a result of this PCO the project schedule will be ${days > 0 ? "increased" : "decreased"} by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}.`
  cover.spacer(6)
  cover.paragraph(schedSentence, { gap: 16 })

  // Never print an email as the signer name (an auth identity can leak in).
  const signerName = data.signerName && !/\S+@\S+\.\S+/.test(data.signerName) ? data.signerName : ""
  cover.paragraph("Sincerely,", { gap: 6 })
  if (sigBytes) await cover.image(sigBytes, { maxH: 46, maxW: 200 })
  cover.paragraph(signerName, { bold: true, gap: 1 })
  cover.paragraph(data.signerTitle ?? "", { muted: true })
  const coverBytes = await cover.save()

  return { backup: backupBytes, cover: coverBytes }
}
