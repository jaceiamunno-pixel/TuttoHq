// Pure PCO document builder — the backup (pricing worksheet) + cover (letter)
// PDFs, assembled from a PLAIN data object with NO database access. Both the
// stored-PDF route (/api/change-orders/pco/[id]/pdf) and the import review's
// no-store preview render through this one function, so a previewed-before-
// commit document is byte-identical to what gets stored on commit.
//
// Totals are recomputed here via the shared computePcoTotals, so the documents
// always reconcile with the log's pricing_sum (which is the same computation).
//
// Visual system: Source Serif 4 (OFL, embedded) for the document title, section
// headings and the company name block; Helvetica for body + numerics. The shared
// PdfDoc primitives now live in pdf-doc.ts (also used by the Purchase Order
// builder); this file holds the PCO-specific document assembly.

import {
  computePcoTotals, laborLineTotal, materialLineTotal,
  type PcoLaborLine, type PcoMaterialLine, type PcoSubLine,
} from "@/app/dashboard/_shared/pco-math"
import {
  PdfDoc, companyBlock, fmtDateLong,
  usd, hrs, n0, CW, M, HAIR, INK, MUTED,
  type Col, type PdfDocAssets,
} from "./pdf-doc"

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
  texturaFee: number | null         // flat cover Textura fee; rendered only when non-zero
  scheduleImpactDays: number | null
  signerName: string | null
  signerTitle: string | null
  projectName: string | null
  projectLocation: string | null
}

// The PCO documents and the PO share one asset shape (logo, signature, company
// identity); the canonical definition lives in pdf-doc.
export type PcoDocAssets = PdfDocAssets

export async function buildPcoDocuments(
  data: PcoDocData,
  assets: PcoDocAssets,
): Promise<{ backup: Uint8Array; cover: Uint8Array }> {
  const { sigBytes } = assets

  const laborInputs: PcoLaborLine[] = data.labor.map(l => ({ qty_reg: l.qty_reg, rate_reg: l.rate_reg, qty_ot: l.qty_ot, rate_ot: l.rate_ot, qty_dt: l.qty_dt, rate_dt: l.rate_dt }))
  const materialInputs: PcoMaterialLine[] = data.materials.map(m => ({ qty: m.qty, unit_price: m.unit_price }))
  const subInputs: PcoSubLine[] = data.subs.map(s => ({ amount: s.amount }))
  const totals = computePcoTotals(laborInputs, materialInputs, subInputs, data.ohpPercent, data.feePercent, data.texturaFee)

  const dateLong = fmtDateLong(data.dateISO)
  const ohpPct = +(Number(data.ohpPercent ?? 0) * 100).toFixed(4)
  const feePct = +(Number(data.feePercent ?? 0) * 100).toFixed(4)
  const footer = `${data.projectName ?? "Project"}  ·  PCO ${data.pcoNumber}`

  // ══ COVER — letter-style change proposal ════════════════════════════════════
  const cover = await PdfDoc.create()
  cover.footerL = footer
  await companyBlock(cover, assets)

  // Large serif document title
  cover.ensure(40)
  cover.text("Proposed Change Order", M, cover.y - 24, cover.serifSemi, 25, INK)
  cover.y -= 36

  // Meta grid — PCO # · Date · Project (Project gets the remaining width so long
  // project names wrap rather than clip; PCO #/Date are short).
  cover.ensure(60)
  const mPco = 80, mDate = 150, mProj = CW - mPco - mDate
  const metaH = Math.max(
    cover.metaCell(M,                 mPco,  "PCO #",   data.pcoNumber),
    cover.metaCell(M + mPco,          mDate, "Date",    dateLong),
    cover.metaCell(M + mPco + mDate,  mProj, "Project", data.projectName ?? "—"),
  )
  cover.y -= metaH
  cover.rule(cover.y + 4, HAIR, 0.6)
  cover.down(6)

  // Proposal title
  if (data.title && data.title.trim()) {
    cover.down(8)
    cover.paragraph(data.title.trim(), cover.serifSemi, 13, INK, 8)
  }

  // Description of work
  if (data.descriptionOfWork && data.descriptionOfWork.trim()) {
    cover.sectionHeading("Description of Work")
    cover.paragraph(data.descriptionOfWork.trim(), cover.sans, 10, INK, 10)
  }

  // Pricing summary — TOTAL == pricing_sum (both from computePcoTotals)
  cover.sectionHeading("Pricing Summary")
  const pricingRows: string[][] = [
    ["Labor", usd(totals.laborSubtotal)],
    ["Material & Equipment", usd(totals.materialsSubtotal)],
    [`OH&P (${ohpPct}%)`, usd(totals.ohpAmount)],
    ["Subcontractor", usd(totals.subSubtotal)],
    [`Fee (${feePct}%)`, usd(totals.feeAmount)],
  ]
  // Textura Fee line only when non-zero (most PCOs carry none).
  if (totals.texturaFee !== 0) pricingRows.push(["Textura Fee", usd(totals.texturaFee)])
  pricingRows.push(["Total", usd(totals.grandTotal)])
  cover.table(
    [{ header: "", w: CW - 150, align: "left" }, { header: "", w: 150, align: "right" }],
    pricingRows,
    { showHeader: false, totalFromIndex: pricingRows.length - 1 },
  )

  // Schedule sentence
  const days = data.scheduleImpactDays ?? 0
  const schedSentence = days === 0
    ? "As a result of this PCO the project schedule will not be impacted."
    : `As a result of this PCO the project schedule will be ${days > 0 ? "increased" : "decreased"} by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}.`
  cover.down(10)
  cover.paragraph(schedSentence, cover.sans, 10, INK, 18)

  // Sign-off — never print an email as the signer name (auth identity leak).
  const signerName = data.signerName && !/\S+@\S+\.\S+/.test(data.signerName) ? data.signerName : ""
  cover.paragraph("Sincerely,", cover.sans, 10, INK, 8)
  if (sigBytes) {
    const emb = await cover.embedImage(sigBytes)
    if (emb) {
      const scale = Math.min(200 / emb.w, 44 / emb.h, 1)
      const dw = emb.w * scale, dh = emb.h * scale
      cover.ensure(dh + 4)
      cover.page.drawImage(emb.img, { x: M, y: cover.y - dh, width: dw, height: dh })
      cover.y -= dh + 4
    }
  }
  if (signerName) cover.text(signerName, M, cover.y - 11, cover.serifSemi, 11, INK)
  cover.y -= 14
  if (data.signerTitle) cover.text(data.signerTitle, M, cover.y - 10, cover.sans, 9, MUTED)
  const coverBytes = await cover.finalize()

  // ══ BACKUP — pricing worksheet ══════════════════════════════════════════════
  const backup = await PdfDoc.create()
  backup.footerL = footer
  await companyBlock(backup, assets)

  backup.ensure(38)
  backup.text("Pricing Backup", M, backup.y - 22, backup.serifSemi, 23, INK)
  backup.y -= 34

  backup.ensure(60)
  const t3 = CW / 3
  const backupMetaH = Math.max(
    backup.metaCell(M,          t3, "PCO #", data.pcoNumber),
    backup.metaCell(M + t3,     t3, "Job #", data.jobNumber ?? "—"),
    backup.metaCell(M + t3 * 2, t3, "Date",  dateLong),
  )
  backup.y -= backupMetaH
  backup.rule(backup.y + 4, HAIR, 0.6)
  backup.down(2)

  // LABOR — full snapshotted roster (every saved line incl. 0-qty)
  backup.sectionHeading("Labor")
  if (data.labor.length) {
    const cols: Col[] = [
      { header: "Description", w: 130, align: "left" },
      { header: "Reg", w: 40, align: "right" },
      { header: "Reg Rate", w: 58, align: "right" },
      { header: "OT", w: 38, align: "right" },
      { header: "OT Rate", w: 56, align: "right" },
      { header: "DT", w: 38, align: "right" },
      { header: "DT Rate", w: 56, align: "right" },
      { header: "Amount", w: 84, align: "right" },
    ]
    const rows = data.labor.map(l => [
      l.description ?? "—",
      hrs(n0(l.qty_reg)), usd(n0(l.rate_reg)),
      hrs(n0(l.qty_ot)),  usd(n0(l.rate_ot)),
      hrs(n0(l.qty_dt)),  usd(n0(l.rate_dt)),
      usd(laborLineTotal(l)),
    ])
    rows.push(["Total Hours", hrs(totals.hoursReg), "", hrs(totals.hoursOt), "", hrs(totals.hoursDt), "", ""])
    rows.push(["Labor Subtotal", "", "", "", "", "", "", usd(totals.laborSubtotal)])
    backup.table(cols, rows, { totalFromIndex: rows.length - 1 })
  } else {
    backup.paragraph("—", backup.sans, 9, MUTED, 4)
  }

  // MATERIAL / EQUIPMENT
  backup.sectionHeading("Material / Equipment")
  if (data.materials.length) {
    const cols: Col[] = [
      { header: "Description", w: 150, align: "left" },
      { header: "Qty", w: 40, align: "right" },
      { header: "Unit", w: 40, align: "left" },
      { header: "Unit Price", w: 70, align: "right" },
      { header: "Note", w: 106, align: "left" },
      { header: "Amount", w: 94, align: "right" },
    ]
    const rows = data.materials.map(m => [
      m.description ?? "—", hrs(n0(m.qty)), m.unit ?? "", usd(n0(m.unit_price)), m.note ?? "", usd(materialLineTotal(m)),
    ])
    rows.push(["Materials Subtotal", "", "", "", "", usd(totals.materialsSubtotal)])
    backup.table(cols, rows, { totalFromIndex: rows.length - 1 })
  } else {
    backup.paragraph("—", backup.sans, 9, MUTED, 4)
  }

  // SUBCONTRACTOR
  backup.sectionHeading("Subcontractor")
  if (data.subs.length) {
    const cols: Col[] = [
      { header: "Name", w: CW - 94, align: "left" },
      { header: "Amount", w: 94, align: "right" },
    ]
    const rows = data.subs.map(s => [s.description ?? "—", usd(n0(s.amount))])
    rows.push(["Subcontractor Subtotal", usd(totals.subSubtotal)])
    backup.table(cols, rows, { totalFromIndex: rows.length - 1 })
  } else {
    backup.paragraph("—", backup.sans, 9, MUTED, 4)
  }

  // TOTALS — OH&P, Grand Total (pre-fee, emphasized), Fee. Backup Grand Total
  // EXCLUDES the fee (historical THP worksheet convention — unchanged).
  backup.down(10)
  backup.table(
    [{ header: "", w: CW - 120, align: "left" }, { header: "", w: 120, align: "right" }],
    [
      [`OH&P (${ohpPct}%)`, usd(totals.ohpAmount)],
      ["Grand Total", usd(totals.preFeeTotal)],
      [`Fee (${feePct}%)`, usd(totals.feeAmount)],
    ],
    { showHeader: false, totalFromIndex: 1 },
  )
  const backupBytes = await backup.finalize()

  return { backup: backupBytes, cover: coverBytes }
}
