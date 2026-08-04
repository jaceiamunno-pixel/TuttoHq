import type { PDFPage } from "pdf-lib"
import { PDFBuilder, PDF, PDFLogCell } from "./pdf-builder"
import { sanitizeWinAnsi } from "./pdf-text"

// Subcontractor Change Order — mirrors the classic GC paper "CHANGE ORDER"
// form (THP → sub layout), rendered tenant-branded: tenant logo + company
// name/address/phone/fax from company_settings, nothing hardcoded.
//
// Page anatomy (portrait letter):
//   letterhead (logo | company block)      | "CHANGE ORDER" header box
//   vendor (TO:) block
//   "YOU ARE HEREBY AUTHORIZED..." banner
//   line grid (Owner C.O.# | GC C.O.# | Description | Cost Code | PRICE) + TOTAL row
//   boilerplate acceptance paragraphs (verbatim from the form)
//   APPROVED AND ACCEPTED signatures (left) | financial recap 1–6 (right)
//
// All money comes in pre-computed (the route's snap_* values) — this module
// never does financial math beyond formatting. Long fields WRAP, never clip
// (wrapTextWith everywhere; the c68bba5 rule).

export interface SubCoPdfData {
  coNumber: string
  originalContractNo: string | null
  coDateISO: string | null
  costCode: string | null
  projectName: string | null
  projectLocation: string | null
  projectNumber: string | null
  vendor: {
    vendor_no: string | null
    company_name: string
    street_address: string | null
    city: string | null
    state: string | null
    zip_code: string | null
  }
  lines: {
    owner_co_number: string | null
    gc_co_number: string | null
    description: string
    cost_code: string | null
    price: number
  }[]
  // Financial recap — the snap_* values just written by the route.
  originalContractAmount: number | null
  previousAdditions: number
  previousDeductions: number
  previousTotal: number
  thisOrder: number
  presentContractAmount: number
  signerName: string | null
  signerTitle: string | null
}

export interface SubCoPdfAssets {
  logoBytes: ArrayBuffer | null
  sigBytes: ArrayBuffer | null
  companyName: string | null
  addressLine1: string | null
  addressLine2: string | null
  phone: string | null
  fax: string | null
  logoScalePct?: number
}

function usd(n: number | null | undefined): string {
  if (n == null) return "—"
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? "-" : ""}$${abs}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${m[2]}/${m[3]}/${m[1]}`   // local-render date-only, no TZ math
}

const BOILERPLATE_AGREEMENT =
  "The above alterations or deductions in and to the plans and specifications referred to in the contract " +
  "(or Purchase Order) between the parties above named are hereby agreed upon and this order is executed " +
  "with the understanding that all conditions of the original contract apply thereto, this Change Order " +
  "becoming a part of the original contract (or Purchase Order)."

const BOILERPLATE_ACCEPT =
  "PLEASE INDICATE your acceptance of this Change Order by signing below and returning the acceptance " +
  "copy to our office as soon as possible."

export async function buildSubChangeOrderPdf(data: SubCoPdfData, assets: SubCoPdfAssets): Promise<Uint8Array> {
  const pdf = await PDFBuilder.create({
    documentType: "Change Order",
    documentNumber: data.coNumber,
    noHeader: true,   // page 1 is the custom form header below
    brandName: assets.companyName ?? undefined,
  })
  const page = (): PDFPage => pdf.doc.getPage(pdf.doc.getPageCount() - 1)
  const M = pdf.M
  const CW = pdf.CW
  const right = M + CW

  const text = (
    p: PDFPage, s: string, x: number, y: number,
    opts: { size?: number; bold?: boolean; color?: typeof PDF.color.ink; alignRight?: boolean } = {},
  ) => {
    const size = opts.size ?? 8.5
    const font = opts.bold ? pdf.bold : pdf.reg
    const clean = sanitizeWinAnsi(s)
    const w = font.widthOfTextAtSize(clean, size)
    p.drawText(clean, {
      x: opts.alignRight ? x - w : x,
      y, size, font, color: opts.color ?? PDF.color.ink,
    })
  }

  // ── Letterhead (left) + CHANGE ORDER box (right) ──────────────────────────
  const top = pdf.H - PDF.topMargin
  const p1 = page()
  const leftW = 280

  let ly = top
  if (assets.logoBytes) {
    // Reuse the builder's tolerant embed via image() is cursor-based; the
    // letterhead is absolutely positioned, so embed directly here.
    let img = null
    try { img = await pdf.doc.embedPng(assets.logoBytes) } catch {
      try { img = await pdf.doc.embedJpg(assets.logoBytes) } catch { img = null }
    }
    if (img) {
      const scale = Math.min(40 / img.height, 140 / img.width, 1)
      const dw = img.width * scale, dh = img.height * scale
      p1.drawImage(img, { x: M, y: top - dh, width: dw, height: dh })
      ly = top - dh - 12
    }
  }
  if (assets.companyName) {
    for (const line of pdf.wrapTextWith(pdf.bold, assets.companyName, 12, leftW)) {
      text(p1, line, M, ly - 12, { size: 12, bold: true })
      ly -= 15
    }
  }
  text(p1, "GENERAL CONTRACTORS", M, ly - 9, { size: 7.5, color: PDF.color.label })
  ly -= 13
  for (const addr of [assets.addressLine1, assets.addressLine2]) {
    if (addr && addr.trim()) {
      text(p1, addr, M, ly - 9, { size: 8, color: PDF.color.label })
      ly -= 11
    }
  }
  const phoneFax = [
    assets.phone?.trim() ? `PHONE ${assets.phone.trim()}` : null,
    assets.fax?.trim() ? `FAX ${assets.fax.trim()}` : null,
  ].filter(Boolean).join("    ")
  if (phoneFax) {
    text(p1, phoneFax, M, ly - 9, { size: 8, color: PDF.color.label })
    ly -= 11
  }
  const letterheadBottom = ly - 4

  // Right: the CHANGE ORDER header box.
  const boxW = 220
  const boxX = right - boxW
  const jobName = [data.projectName, data.projectLocation].filter(Boolean).join(" — ")
  const boxRows: { label: string; value: string }[] = [
    { label: "Original Contract No.", value: data.originalContractNo?.trim() || "—" },
    { label: "Change Order No.", value: data.coNumber },
    { label: "Date", value: fmtDate(data.coDateISO) },
    { label: "Job Name", value: jobName || "—" },
    { label: "Job #", value: data.projectNumber?.trim() || "—" },
    { label: "Cost Code", value: data.costCode?.trim() || "—" },
  ]
  const boxLabelW = 88
  const boxValueW = boxW - boxLabelW - 18
  const rowLines = boxRows.map(r => pdf.wrapTextWith(pdf.reg, r.value, 8, boxValueW))
  const titleH = 22
  const rowH = (n: number) => 6 + n * 10
  const boxH = titleH + rowLines.reduce((s, l) => s + rowH(l.length), 0) + 6
  p1.drawRectangle({
    x: boxX, y: top - boxH, width: boxW, height: boxH,
    borderColor: PDF.color.ruleStrong, borderWidth: 1,
  })
  {
    const title = "CHANGE ORDER"
    const tw = pdf.bold.widthOfTextAtSize(title, 13)
    text(p1, title, boxX + (boxW - tw) / 2, top - 16, { size: 13, bold: true })
    p1.drawLine({
      start: { x: boxX, y: top - titleH }, end: { x: boxX + boxW, y: top - titleH },
      thickness: 0.75, color: PDF.color.ruleStrong,
    })
    let by = top - titleH
    boxRows.forEach((r, i) => {
      const h = rowH(rowLines[i].length)
      text(p1, r.label, boxX + 6, by - 13, { size: 7, bold: true, color: PDF.color.label })
      let vy = by - 13
      for (const line of rowLines[i]) {
        text(p1, line, boxX + boxLabelW + 6, vy, { size: 8 })
        vy -= 10
      }
      by -= h
      if (i < boxRows.length - 1) {
        p1.drawLine({ start: { x: boxX, y: by }, end: { x: boxX + boxW, y: by }, thickness: 0.5, color: PDF.color.rule })
      }
    })
  }

  pdf.y = Math.min(letterheadBottom, top - boxH) - 18

  // ── Vendor (TO:) block ────────────────────────────────────────────────────
  {
    const p = page()
    text(p, "TO:", M, pdf.y - 9, { size: 8, bold: true, color: PDF.color.label })
    const vx = M + 30
    const cityLine = [data.vendor.city, [data.vendor.state, data.vendor.zip_code].filter(Boolean).join(" ")]
      .filter(s => s && String(s).trim()).join(", ")
    const vendorLines: { s: string; bold: boolean }[] = []
    if (data.vendor.vendor_no?.trim()) vendorLines.push({ s: `Vendor No. ${data.vendor.vendor_no.trim()}`, bold: false })
    for (const l of pdf.wrapTextWith(pdf.bold, data.vendor.company_name, 10, CW - 260)) {
      vendorLines.push({ s: l, bold: true })
    }
    if (data.vendor.street_address?.trim()) vendorLines.push({ s: data.vendor.street_address.trim(), bold: false })
    if (cityLine) vendorLines.push({ s: cityLine, bold: false })
    let vy = pdf.y
    for (const l of vendorLines) {
      text(p, l.s, vx, vy - (l.bold ? 10 : 9), { size: l.bold ? 10 : 8.5, bold: l.bold })
      vy -= l.bold ? 13 : 11.5
    }
    pdf.y = vy - 10
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  {
    const p = page()
    const banner = "YOU ARE HEREBY AUTHORIZED TO MAKE THE FOLLOWING CHANGES"
    const bw = pdf.bold.widthOfTextAtSize(banner, 9.5)
    text(p, banner, M + (CW - bw) / 2, pdf.y - 10, { size: 9.5, bold: true })
    pdf.y -= 22
  }

  // ── Line grid ─────────────────────────────────────────────────────────────
  const TOTAL_LABEL = "TOTAL CHANGE ORDER"
  const gridRows: PDFLogCell[][] = data.lines.map(l => [
    l.owner_co_number ?? "",
    l.gc_co_number ?? "",
    l.description,
    l.cost_code ?? "",
    usd(l.price),
  ])
  gridRows.push(["", "", TOTAL_LABEL, "", usd(data.thisOrder)])
  pdf.logTable(
    [
      { header: "Owner C.O.#", width: 58 },
      { header: "GC C.O.#", width: 58 },
      { header: "Description", width: 240 },
      { header: "Cost Code", width: 70 },
      { header: "Price", width: 100, align: "right" },
    ],
    gridRows,
    { highlight: r => r[2] === TOTAL_LABEL },
  )

  // ── Boilerplate (verbatim from the form) ──────────────────────────────────
  pdf.spacer(4)
  pdf.paragraph(BOILERPLATE_AGREEMENT, { size: 8, gap: 6 })
  pdf.paragraph(BOILERPLATE_ACCEPT, { size: 8, gap: 10 })

  // ── Signatures (left) + financial recap 1–6 (right) ───────────────────────
  const blockH = 168
  if (pdf.y - blockH < PDF.footerH + 14) pdf.pageBreak()
  {
    const p = page()
    const blockTop = pdf.y
    const sigW = 270
    const recapW = 220
    const recapX = right - recapW

    // Left: APPROVED AND ACCEPTED
    text(p, "APPROVED AND ACCEPTED", M, blockTop - 10, { size: 9, bold: true })
    let sy = blockTop - 26
    if (assets.companyName) {
      for (const line of pdf.wrapTextWith(pdf.bold, assets.companyName, 8.5, sigW)) {
        text(p, line, M, sy - 9, { size: 8.5, bold: true })
        sy -= 11
      }
    }
    // GC signature image sits ON the line when a snapshot exists.
    const gcLineY = sy - 40
    if (assets.sigBytes) {
      let img = null
      try { img = await pdf.doc.embedPng(assets.sigBytes) } catch {
        try { img = await pdf.doc.embedJpg(assets.sigBytes) } catch { img = null }
      }
      if (img) {
        const scale = Math.min(30 / img.height, 150 / img.width, 1)
        const dw = img.width * scale, dh = img.height * scale
        p.drawImage(img, { x: M + 8, y: gcLineY + 2, width: dw, height: dh })
      }
    }
    p.drawLine({ start: { x: M, y: gcLineY }, end: { x: M + sigW - 60, y: gcLineY }, thickness: 0.5, color: PDF.color.ink })
    const gcSigner = [data.signerName?.trim(), data.signerTitle?.trim()].filter(Boolean).join(", ")
    text(p, gcSigner ? `BY  ${gcSigner}` : "BY", M, gcLineY - 10, { size: 7.5, color: PDF.color.label })
    p.drawLine({ start: { x: M + sigW - 50, y: gcLineY }, end: { x: M + sigW, y: gcLineY }, thickness: 0.5, color: PDF.color.ink })
    text(p, "DATE", M + sigW - 50, gcLineY - 10, { size: 7.5, color: PDF.color.label })

    // Subcontractor acceptance — blank line + BY line.
    let vy2 = gcLineY - 30
    for (const line of pdf.wrapTextWith(pdf.bold, data.vendor.company_name, 8.5, sigW)) {
      text(p, line, M, vy2 - 9, { size: 8.5, bold: true })
      vy2 -= 11
    }
    const subLineY = vy2 - 30
    p.drawLine({ start: { x: M, y: subLineY }, end: { x: M + sigW - 60, y: subLineY }, thickness: 0.5, color: PDF.color.ink })
    text(p, "BY", M, subLineY - 10, { size: 7.5, color: PDF.color.label })
    p.drawLine({ start: { x: M + sigW - 50, y: subLineY }, end: { x: M + sigW, y: subLineY }, thickness: 0.5, color: PDF.color.ink })
    text(p, "DATE", M + sigW - 50, subLineY - 10, { size: 7.5, color: PDF.color.label })

    // Right: financial recap, numbered 1–6, from the snap_* values.
    const recap: { label: string; value: string; strong?: boolean }[] = [
      { label: "1. Original Contract Amt", value: usd(data.originalContractAmount) },
      { label: "2. Previous Additions", value: usd(data.previousAdditions) },
      { label: "3. Previous Deductions", value: usd(data.previousDeductions) },
      { label: "4. Previous Total", value: usd(data.previousTotal) },
      { label: "5. This Order", value: usd(data.thisOrder) },
      { label: "6. Present Contract Amount", value: usd(data.presentContractAmount), strong: true },
    ]
    let ry = blockTop
    recap.forEach(r => {
      const rh = 17
      text(p, r.label, recapX, ry - 11, { size: 8, bold: r.strong ?? false, color: PDF.color.label })
      text(p, r.value, right, ry - 11, { size: 8.5, bold: r.strong ?? false, alignRight: true })
      p.drawLine({
        start: { x: recapX, y: ry - rh + 2 }, end: { x: right, y: ry - rh + 2 },
        thickness: r.strong ? 0.9 : 0.5, color: r.strong ? PDF.color.ruleStrong : PDF.color.rule,
      })
      ry -= rh
    })

    pdf.y = Math.min(subLineY - 16, ry - 8)
  }

  return pdf.save()
}
