// Pure PCO document builder — the backup (pricing worksheet) + cover (letter)
// PDFs, assembled from a PLAIN data object with NO database access. Both the
// stored-PDF route (/api/change-orders/pco/[id]/pdf) and the import review's
// no-store preview render through this one function, so a previewed-before-
// commit document is byte-identical to what gets stored on commit.
//
// Totals are recomputed here via the shared computePcoTotals, so the documents
// always reconcile with the log's pricing_sum (which is the same computation).
//
// Visual system (redesigned): Source Serif 4 (OFL, embedded) for the document
// title, section headings and the company name block; Helvetica for body +
// numerics. Hairline horizontal rules only — no full-grid table boxes. One
// restrained accent (deep slate #1F3A52) for rules and labels; everything else
// near-black on white. Both documents share the same primitives below.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib"
import fontkit from "@pdf-lib/fontkit"

type RGB = ReturnType<typeof rgb>
import fs from "node:fs"
import path from "node:path"
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
  texturaFee: number | null         // flat cover Textura fee; rendered only when non-zero
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
  addressLine1?: string | null
  addressLine2?: string | null
}

function fmtDateLong(dateISO: string | null): string {
  if (!dateISO) return ""
  try { return new Date(dateISO + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) }
  catch { return dateISO }
}

// ─── Design tokens ─────────────────────────────────────────────────────────────
const PW = 612, PH = 792           // US Letter
const M = 56                       // ~0.78in margin (≥ 0.6in required)
const CW = PW - M * 2              // 500
const BOTTOM = 64                  // lowest y content may occupy (footer band)

const SLATE  = rgb(0x1f / 255, 0x3a / 255, 0x52 / 255)  // #1F3A52 — rules + labels
const INK    = rgb(0.105, 0.118, 0.137)                  // near-black body
const MUTED  = rgb(0.42, 0.45, 0.50)                     // quiet secondary text
const HAIR   = rgb(0.84, 0.86, 0.89)                     // hairline gray
const WHITE  = rgb(1, 1, 1)

// Source Serif 4 TTF bytes — read from the repo at runtime. next.config's
// outputFileTracingIncludes bundles these into the serverless function.
let _serif: { reg: Buffer; semi: Buffer } | null = null
function serifBytes() {
  if (!_serif) {
    const dir = path.join(process.cwd(), "src", "lib", "fonts")
    _serif = {
      reg:  fs.readFileSync(path.join(dir, "SourceSerif4-Regular.ttf")),
      semi: fs.readFileSync(path.join(dir, "SourceSerif4-SemiBold.ttf")),
    }
  }
  return _serif
}

type Align = "left" | "right"
interface Col { header: string; w: number; align: Align }

// ─── Lightweight renderer shared by both documents ──────────────────────────────
class PcoDoc {
  doc!: PDFDocument
  page!: PDFPage
  pages: PDFPage[] = []
  y = PH - M
  serif!: PDFFont      // Source Serif 4 Regular
  serifSemi!: PDFFont  // Source Serif 4 SemiBold
  sans!: PDFFont       // Helvetica
  sansBold!: PDFFont   // Helvetica-Bold
  footerL = ""

  static async create(): Promise<PcoDoc> {
    const d = new PcoDoc()
    d.doc = await PDFDocument.create()
    d.doc.registerFontkit(fontkit)
    const f = serifBytes()
    d.serif     = await d.doc.embedFont(f.reg,  { subset: true })
    d.serifSemi = await d.doc.embedFont(f.semi, { subset: true })
    d.sans      = await d.doc.embedFont(StandardFonts.Helvetica)
    d.sansBold  = await d.doc.embedFont(StandardFonts.HelveticaBold)
    d.newPage()
    return d
  }

  newPage() {
    this.page = this.doc.addPage([PW, PH])
    this.pages.push(this.page)
    this.y = PH - M
  }

  ensure(h: number) { if (this.y - h < BOTTOM) this.newPage() }
  down(pt: number) { this.y -= pt }

  // Truncate text with an ellipsis to fit maxW at size.
  clip(font: PDFFont, text: string, maxW: number, size: number): string {
    if (font.widthOfTextAtSize(text, size) <= maxW) return text
    let s = text
    while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > maxW) s = s.slice(0, -1)
    return s + "…"
  }

  text(s: string, x: number, baselineY: number, font: PDFFont, size: number, color: RGB) {
    this.page.drawText(s, { x, y: baselineY, size, font, color })
  }
  // Draw right-aligned text whose right edge sits at xRight.
  rtext(s: string, xRight: number, baselineY: number, font: PDFFont, size: number, color: RGB) {
    const w = font.widthOfTextAtSize(s, size)
    this.page.drawText(s, { x: xRight - w, y: baselineY, size, font, color })
  }
  rule(y: number, color: RGB, thickness = 0.6, x0 = M, x1 = M + CW) {
    this.page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color })
  }

  // Wrap text to width; honors explicit newlines.
  wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
    const out: string[] = []
    for (const para of text.split(/\r?\n/)) {
      const words = para.split(/\s+/).filter(Boolean)
      let cur = ""
      for (const w of words) {
        const next = cur ? `${cur} ${w}` : w
        if (font.widthOfTextAtSize(next, size) <= maxW) cur = next
        else { if (cur) out.push(cur); cur = w }
      }
      out.push(cur)
    }
    return out
  }

  paragraph(text: string, font: PDFFont, size: number, color: RGB, gap = 6, lead = 5) {
    const lineH = size + lead
    for (const line of this.wrap(font, text, size, CW)) {
      this.ensure(lineH)
      this.text(line, M, this.y - size, font, size, color)
      this.y -= lineH
    }
    this.y -= gap
  }

  // A serif section heading in slate, with a hairline slate rule beneath.
  sectionHeading(label: string) {
    this.down(10)
    this.ensure(20)
    this.text(label, M, this.y - 11, this.serifSemi, 11, SLATE)
    this.y -= 15
    this.rule(this.y, SLATE, 0.6)
    this.y -= 9
  }

  // A slate uppercase micro-label with a near-black value beneath it.
  metaCell(x: number, w: number, label: string, value: string) {
    this.text(label.toUpperCase(), x, this.y - 8, this.sansBold, 7, SLATE)
    const v = this.clip(this.serif, value || "—", w, 12)
    this.text(v, x, this.y - 23, this.serif, 12, INK)
  }

  // Hairline table: slate column-header rule, plain body rows, a single slate
  // rule above the first total row (which renders bold + near-black). Numerics
  // are right-aligned and tabular (Helvetica digits are uniform width).
  table(cols: Col[], rows: string[][], opts: { totalFromIndex?: number; showHeader?: boolean } = {}) {
    const showHeader = opts.showHeader ?? true
    const headerH = 16, rowH = 17
    const PAD = 6  // internal gutter so adjacent right/left columns never touch
    // Cell x for the given alignment + a clip width that respects the gutter.
    // First column stays flush at the margin so it lines up with section headings.
    const cellX = (cx: number, c: Col, ci: number, font: PDFFont, size: number, raw: string) => {
      if (c.align === "right") {
        const t = this.clip(font, raw, c.w - PAD, size)        // right gutter only
        return { t, x: cx + c.w - PAD, right: true as const }
      }
      const lg = ci === 0 ? 0 : PAD                            // left gutter only (first col flush)
      return { t: this.clip(font, raw, c.w - lg, size), x: cx + lg, right: false as const }
    }
    const drawHeader = () => {
      if (!showHeader) return
      this.ensure(headerH)
      let cx = M
      cols.forEach((c, ci) => {
        if (c.header) {
          const { t, x, right } = cellX(cx, c, ci, this.sansBold, 7, c.header.toUpperCase())
          if (right) this.rtext(t, x, this.y - 10, this.sansBold, 7, SLATE)
          else this.text(t, x, this.y - 10, this.sansBold, 7, SLATE)
        }
        cx += c.w
      })
      this.y -= headerH
      this.rule(this.y + 2, SLATE, 0.6)
      this.y -= 4
    }
    drawHeader()
    rows.forEach((r, i) => {
      const isTotal = opts.totalFromIndex != null && i >= opts.totalFromIndex
      this.ensure(rowH + (i === opts.totalFromIndex ? 6 : 0))
      if (i === opts.totalFromIndex) {
        this.down(4)
        this.rule(this.y + 2, SLATE, 0.8)
        this.down(2)
      }
      const font = isTotal ? this.sansBold : this.sans
      let cx = M
      cols.forEach((c, ci) => {
        const { t, x, right } = cellX(cx, c, ci, font, 9, r[ci] ?? "")
        if (right) this.rtext(t, x, this.y - 12, font, 9, INK)
        else this.text(t, x, this.y - 12, font, 9, INK)
        cx += c.w
      })
      this.y -= rowH
    })
  }

  async embedImage(bytes: ArrayBuffer): Promise<{ w: number; h: number; img: import("pdf-lib").PDFImage } | null> {
    try { const img = await this.doc.embedPng(bytes); return { w: img.width, h: img.height, img } }
    catch {
      try { const img = await this.doc.embedJpg(bytes); return { w: img.width, h: img.height, img } }
      catch { return null }
    }
  }

  // Footer on every page: "project · PCO #" left, "Page n of m" right. Small + quiet.
  finalize(): Promise<Uint8Array> {
    const total = this.pages.length
    this.pages.forEach((pg, i) => {
      pg.drawLine({ start: { x: M, y: BOTTOM - 14 }, end: { x: M + CW, y: BOTTOM - 14 }, thickness: 0.5, color: HAIR })
      if (this.footerL) pg.drawText(this.clip(this.sans, this.footerL, CW - 120, 7.5), { x: M, y: BOTTOM - 26, size: 7.5, font: this.sans, color: MUTED })
      const pageStr = `Page ${i + 1} of ${total}`
      const pw = this.sans.widthOfTextAtSize(pageStr, 7.5)
      pg.drawText(pageStr, { x: M + CW - pw, y: BOTTOM - 26, size: 7.5, font: this.sans, color: MUTED })
    })
    return this.doc.save()
  }
}

// ─── Company block — logo + serif name + address (top of each document) ─────────
async function companyBlock(d: PcoDoc, assets: PcoDocAssets) {
  const top = d.y
  let textX = M
  let logoBottom = top
  if (assets.logoBytes) {
    const emb = await d.embedImage(assets.logoBytes)
    if (emb) {
      const scale = Math.min(52 / emb.h, 150 / emb.w, 1)
      const dw = emb.w * scale, dh = emb.h * scale
      d.page.drawImage(emb.img, { x: M, y: top - dh, width: dw, height: dh })
      textX = M + dw + 16
      logoBottom = top - dh
    }
  }
  let ty = top
  if (assets.companyName) {
    d.text(d.clip(d.serifSemi, assets.companyName, CW - (textX - M), 15), textX, ty - 13, d.serifSemi, 15, INK)
    ty -= 18
  }
  const addr = [assets.addressLine1, assets.addressLine2, assets.phone].filter(Boolean) as string[]
  for (const line of addr) {
    d.text(d.clip(d.sans, line, CW - (textX - M), 8.5), textX, ty - 9, d.sans, 8.5, MUTED)
    ty -= 11
  }
  d.y = Math.min(ty, logoBottom) - 16
}

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
  const projLine = [data.projectName, data.projectLocation].filter(Boolean).join(" · ")
  const footer = `${data.projectName ?? "Project"}  ·  PCO ${data.pcoNumber}`

  // ══ COVER — letter-style change proposal ════════════════════════════════════
  const cover = await PcoDoc.create()
  cover.footerL = footer
  await companyBlock(cover, assets)

  // Large serif document title
  cover.ensure(40)
  cover.text("Proposed Change Order", M, cover.y - 24, cover.serifSemi, 25, INK)
  cover.y -= 36

  // Meta grid — PCO # · Date · Project (Project gets the remaining width so long
  // project names don't clip; PCO #/Date are short).
  cover.ensure(30)
  const mPco = 80, mDate = 150, mProj = CW - mPco - mDate
  cover.metaCell(M,                 mPco,  "PCO #",   data.pcoNumber)
  cover.metaCell(M + mPco,          mDate, "Date",    dateLong)
  cover.metaCell(M + mPco + mDate,  mProj, "Project", data.projectName ?? "—")
  cover.y -= 30
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
  const backup = await PcoDoc.create()
  backup.footerL = footer
  await companyBlock(backup, assets)

  backup.ensure(38)
  backup.text("Pricing Backup", M, backup.y - 22, backup.serifSemi, 23, INK)
  backup.y -= 34

  backup.ensure(30)
  const t3 = CW / 3
  backup.metaCell(M,          t3, "PCO #", data.pcoNumber)
  backup.metaCell(M + t3,     t3, "Job #", data.jobNumber ?? "—")
  backup.metaCell(M + t3 * 2, t3, "Date",  dateLong)
  backup.y -= 30
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
