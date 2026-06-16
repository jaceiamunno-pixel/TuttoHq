// Shared PDF house style for TuttoHQ documents (PCO cover/backup, Purchase
// Order, …). Extracted verbatim from the original pco-pdf.ts so every generated
// document inherits one visual system; pco-pdf.ts and po-pdf.ts both build on
// the PdfDoc primitives below.
//
// Visual system: Source Serif 4 (OFL, embedded) for the document title, section
// headings and the company name block; Helvetica for body + numerics. Hairline
// horizontal rules only — no full-grid table boxes. One restrained accent (deep
// slate #1F3A52) for rules and labels; everything else near-black on white.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib"
import fontkit from "@pdf-lib/fontkit"
import fs from "node:fs"
import path from "node:path"

export type RGB = ReturnType<typeof rgb>

export const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
export const hrs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
export const n0 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export function fmtDateLong(dateISO: string | null): string {
  if (!dateISO) return ""
  try { return new Date(dateISO + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) }
  catch { return dateISO }
}

// ─── Design tokens ─────────────────────────────────────────────────────────────
export const PW = 612, PH = 792           // US Letter
export const M = 56                        // ~0.78in margin (≥ 0.6in required)
export const CW = PW - M * 2               // 500
export const BOTTOM = 64                   // lowest y content may occupy (footer band)

export const SLATE  = rgb(0x1f / 255, 0x3a / 255, 0x52 / 255)  // #1F3A52 — rules + labels
export const INK    = rgb(0.105, 0.118, 0.137)                  // near-black body
export const MUTED  = rgb(0.42, 0.45, 0.50)                     // quiet secondary text
export const HAIR   = rgb(0.84, 0.86, 0.89)                     // hairline gray
export const WHITE  = rgb(1, 1, 1)

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

export type Align = "left" | "right"
export interface Col { header: string; w: number; align: Align }

export interface PdfDocAssets {
  logoBytes: ArrayBuffer | null
  sigBytes: ArrayBuffer | null
  companyName: string | null
  phone: string | null
  addressLine1?: string | null
  addressLine2?: string | null
}

// ─── Lightweight renderer shared by all documents ───────────────────────────────
export class PdfDoc {
  doc!: PDFDocument
  page!: PDFPage
  pages: PDFPage[] = []
  y = PH - M
  serif!: PDFFont      // Source Serif 4 Regular
  serifSemi!: PDFFont  // Source Serif 4 SemiBold
  sans!: PDFFont       // Helvetica
  sansBold!: PDFFont   // Helvetica-Bold
  footerL = ""

  static async create(): Promise<PdfDoc> {
    const d = new PdfDoc()
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

  // Footer on every page: a left caption + "Page n of m" right. Small + quiet.
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
export async function companyBlock(d: PdfDoc, assets: PdfDocAssets) {
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
