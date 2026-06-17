// Pure Purchase Order document builder — a single PO PDF assembled from a PLAIN
// data object with NO database access (the route does the DB read + asset fetch
// + storage write, mirroring the PCO PDF route).
//
// Visually inherits the PCO house style: it builds on the shared PdfDoc
// primitives (Source Serif 4 title/headings, Helvetica body/numerics, hairline
// rules, the deep-slate accent) so a PO and a PCO read as the same document
// family. See pdf-doc.ts for the primitives.

import {
  PdfDoc, companyBlock, fmtDateLong,
  usd, n0, CW, M, HAIR, INK, MUTED, SLATE,
  type Col, type PdfDocAssets, type RGB,
} from "./pdf-doc"

const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

export interface PoDocLine {
  quantity: number | null
  description: string | null
  unitPrice: number | null
}

export interface PoDocData {
  poNumber: string                 // display number, e.g. "THP-1042"
  dateOrderISO: string | null      // 'YYYY-MM-DD' — date of order
  dateRequired: string | null      // free text (e.g. "ASAP", "2 weeks ARO")
  terms: string | null
  costCode: string | null
  ctTaxTreatment: "included" | "exempt" | null   // CT Sales & Use Tax
  // Vendor block (snapshot of the linked vendor)
  vendorName: string | null
  vendorStreet: string | null
  vendorCity: string | null
  vendorState: string | null
  vendorZip: string | null
  // Job block (from the linked project)
  projectName: string | null
  projectNumber: string | null
  projectLocation: string | null
  lineItems: PoDocLine[]
  notes: string | null
}

export type PoDocAssets = PdfDocAssets

// City / State ZIP on one line, tolerating any missing piece.
function cityLine(city: string | null, state: string | null, zip: string | null): string {
  const cs = [city, state].filter(Boolean).join(", ")
  return [cs, zip].filter(Boolean).join(" ").trim()
}

export async function buildPurchaseOrderDocument(
  data: PoDocData,
  assets: PoDocAssets,
): Promise<Uint8Array> {
  const company = assets.companyName ?? "the Contractor"
  const dateLong = fmtDateLong(data.dateOrderISO)
  const footer = `${data.projectName ?? "Project"}  ·  PO ${data.poNumber}`

  const doc = await PdfDoc.create()
  doc.footerL = footer
  await companyBlock(doc, assets)

  // ── Title ─────────────────────────────────────────────────────────────────
  doc.ensure(40)
  doc.text("Purchase Order", M, doc.y - 24, doc.serifSemi, 25, INK)
  doc.y -= 36

  // ── Meta grid — PO # · Date of Order · Date Required ─────────────────────────
  doc.ensure(60)
  const mPo = 150, mDate = 150, mReq = CW - mPo - mDate
  const metaH = Math.max(
    doc.metaCell(M,                mPo,  "PO #",         data.poNumber),
    doc.metaCell(M + mPo,          mDate, "Date of Order", dateLong),
    doc.metaCell(M + mPo + mDate,  mReq, "Date Required", data.dateRequired ?? "—"),
  )
  doc.y -= metaH
  doc.rule(doc.y + 4, HAIR, 0.6)
  doc.down(8)

  // ── Vendor + Job columns ─────────────────────────────────────────────────────
  // Two labelled blocks side by side; each tracks its own running baseline and we
  // resume below the taller of the two.
  const colW = (CW - 24) / 2
  const xL = M, xR = M + colW + 24

  const labeledBlock = (x: number, w: number, label: string, lines: { t: string; font: typeof doc.serif; size: number; color: RGB }[]): number => {
    let yy = doc.y
    doc.text(label.toUpperCase(), x, yy - 8, doc.sansBold, 7, SLATE)
    yy -= 22
    for (const ln of lines) {
      if (!ln.t) continue
      // Wrap (never clip) — long vendor / project names flow onto extra lines.
      for (const wl of doc.wrap(ln.font, ln.t, ln.size, w)) {
        doc.text(wl, x, yy - ln.size, ln.font, ln.size, ln.color)
        yy -= ln.size + 4
      }
    }
    return yy
  }

  const vendorBottom = labeledBlock(xL, colW, "Vendor", [
    { t: data.vendorName ?? "—", font: doc.serif, size: 12, color: INK },
    { t: data.vendorStreet ?? "", font: doc.sans, size: 9, color: MUTED },
    { t: cityLine(data.vendorCity, data.vendorState, data.vendorZip), font: doc.sans, size: 9, color: MUTED },
  ])
  const jobBottom = labeledBlock(xR, colW, "Job", [
    { t: data.projectName ?? "—", font: doc.serif, size: 12, color: INK },
    { t: data.projectNumber ? `Project No. ${data.projectNumber}` : "", font: doc.sans, size: 9, color: MUTED },
    { t: data.projectLocation ?? "", font: doc.sans, size: 9, color: MUTED },
  ])
  doc.y = Math.min(vendorBottom, jobBottom) - 6
  doc.rule(doc.y + 2, HAIR, 0.6)
  doc.down(6)

  // ── Terms · Cost Code · CT Sales & Use Tax ───────────────────────────────────
  doc.ensure(60)
  const t3 = CW / 3
  const taxLabel = data.ctTaxTreatment === "included" ? "Included" : data.ctTaxTreatment === "exempt" ? "Exempt" : "—"
  const meta2H = Math.max(
    doc.metaCell(M,          t3, "Terms",     data.terms ?? "—"),
    doc.metaCell(M + t3,     t3, "Cost Code", data.costCode ?? "—"),
    doc.metaCell(M + t3 * 2, t3, "CT Sales & Use Tax", taxLabel),
  )
  doc.y -= meta2H

  // ── Line items ───────────────────────────────────────────────────────────────
  doc.sectionHeading("Items")
  const cols: Col[] = [
    { header: "Qty", w: 50, align: "right" },
    { header: "Description", w: CW - 50 - 90 - 90, align: "left" },
    { header: "Unit Price", w: 90, align: "right" },
    { header: "Amount", w: 90, align: "right" },
  ]
  let total = 0
  const rows: string[][] = data.lineItems.map(li => {
    const qty = n0(li.quantity)
    const price = n0(li.unitPrice)
    const amt = qty * price
    total += amt
    return [qtyFmt(qty), li.description ?? "—", usd(price), usd(amt)]
  })
  if (rows.length === 0) rows.push(["", "—", "", usd(0)])
  rows.push(["", "", "Total", usd(total)])
  doc.table(cols, rows, { totalFromIndex: rows.length - 1 })

  // ── Notes (optional) ──────────────────────────────────────────────────────────
  if (data.notes && data.notes.trim()) {
    doc.sectionHeading("Notes")
    doc.paragraph(data.notes.trim(), doc.sans, 9, INK, 8)
  }

  // ── Insurance / COI boilerplate ───────────────────────────────────────────────
  doc.sectionHeading("Insurance & Conditions")
  doc.paragraph(
    `The Vendor shall maintain Commercial General Liability, Automobile Liability, and Workers' Compensation insurance in the amounts required by the Contract Documents, and shall name ${company} and the Owner as additional insureds. A current Certificate of Insurance must be on file with ${company} prior to delivery or commencement of work.`,
    doc.sans, 9, INK, 6,
  )
  doc.paragraph(
    "Materials and work furnished under this Purchase Order shall conform to the project plans and specifications and all applicable codes. This Purchase Order, including the terms above, constitutes the entire agreement for the work described and supersedes any prior quotations.",
    doc.sans, 9, INK, 12,
  )

  // ── Acceptance / signature block ────────────────────────────────────────────
  // Two signature lines in the PCO sign-off spirit: one for the issuing company,
  // one for the vendor's acceptance. Reserve headroom for a wet signature.
  doc.ensure(58)
  doc.down(28)
  const sigW = (CW - 40) / 2
  const xS1 = M, xS2 = M + sigW + 40
  doc.rule(doc.y, INK, 0.6, xS1, xS1 + sigW)
  doc.rule(doc.y, INK, 0.6, xS2, xS2 + sigW)
  doc.text(`Authorized by — ${company}`, xS1, doc.y - 10, doc.sans, 7.5, MUTED)
  doc.text("Accepted by — Vendor", xS2, doc.y - 10, doc.sans, 7.5, MUTED)
  doc.down(14)
  doc.text("Date:", xS1, doc.y - 8, doc.sans, 7.5, MUTED)
  doc.text("Date:", xS2, doc.y - 8, doc.sans, 7.5, MUTED)

  return doc.finalize()
}
