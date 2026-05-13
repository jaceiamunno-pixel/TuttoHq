import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib"

// ─── Color palette ────────────────────────────────────────────────────────────
export const C = {
  navy:       rgb(0.07, 0.13, 0.28),
  navyMid:    rgb(0.12, 0.22, 0.44),
  accent:     rgb(0.18, 0.44, 0.92),
  dark:       rgb(0.08, 0.08, 0.12),
  mid:        rgb(0.32, 0.35, 0.44),
  label:      rgb(0.48, 0.52, 0.62),
  border:     rgb(0.84, 0.87, 0.92),
  rowBg:      rgb(0.975, 0.978, 0.984),
  white:      rgb(1, 1, 1),
  lgray:      rgb(0.72, 0.75, 0.80),
  green:      rgb(0.06, 0.46, 0.18),
  greenLight: rgb(0.88, 0.96, 0.90),
  red:        rgb(0.68, 0.09, 0.09),
  redLight:   rgb(0.98, 0.90, 0.90),
  amber:      rgb(0.62, 0.38, 0.02),
  amberLight: rgb(0.99, 0.94, 0.84),
  blue:       rgb(0.18, 0.44, 0.92),
  blueLight:  rgb(0.88, 0.93, 0.99),
  footerGray: rgb(0.55, 0.58, 0.64),
}

// Status badge color presets
export const STATUS_COLORS: Record<string, [number,number,number,number,number,number]> = {
  Open:     [0.18,0.44,0.92,  0.88,0.93,0.99],
  Closed:   [0.06,0.46,0.18,  0.88,0.96,0.90],
  Approved: [0.06,0.46,0.18,  0.88,0.96,0.90],
  Draft:    [0.48,0.52,0.62,  0.94,0.95,0.97],
  Pending:  [0.62,0.38,0.02,  0.99,0.94,0.84],
  Rejected: [0.68,0.09,0.09,  0.98,0.90,0.90],
  Void:     [0.48,0.52,0.62,  0.94,0.95,0.97],
  High:     [0.68,0.09,0.09,  0.98,0.90,0.90],
  Medium:   [0.62,0.38,0.02,  0.99,0.94,0.84],
  Low:      [0.06,0.46,0.18,  0.88,0.96,0.90],
  Current:  [0.18,0.44,0.92,  0.88,0.93,0.99],
  Superseded:[0.48,0.52,0.62, 0.94,0.95,0.97],
}

// ─── PDFBuilder ───────────────────────────────────────────────────────────────
export class PDFBuilder {
  doc!: PDFDocument
  page!: PDFPage
  bold!: PDFFont
  reg!: PDFFont

  W = 612; H = 792; M = 30
  get CW() { return this.W - this.M * 2 }   // 552px content width
  y = 0
  rowH = 42; lblSz = 6.5; valSz = 11

  private constructor() {}

  static async create(title: string, logoBytes: ArrayBuffer | null): Promise<PDFBuilder> {
    const b = new PDFBuilder()
    b.doc  = await PDFDocument.create()
    b.bold = await b.doc.embedFont(StandardFonts.HelveticaBold)
    b.reg  = await b.doc.embedFont(StandardFonts.Helvetica)
    b.page = b.doc.addPage([b.W, b.H])
    // Accent strip — 4px, runs the full left edge of the page
    b.page.drawRectangle({ x: 0, y: 0, width: 4, height: b.H, color: C.accent })
    await b._drawHeader(title, logoBytes)
    return b
  }

  private async _drawHeader(title: string, logoBytes: ArrayBuffer | null) {
    const hH = 76, aH = 4

    // Navy fill
    this.page.drawRectangle({ x: 0, y: this.H - hH, width: this.W, height: hH, color: C.navy })
    // Accent underline
    this.page.drawRectangle({ x: 0, y: this.H - hH - aH, width: this.W, height: aH, color: C.accent })

    // Logo — right-aligned, vertically centered
    if (logoBytes) {
      try {
        let img
        try { img = await this.doc.embedPng(logoBytes) }
        catch { img = await this.doc.embedJpg(logoBytes) }
        const { width: iw, height: ih } = img.scale(1)
        const scale = Math.min(52 / ih, 140 / iw, 1)
        const dw = iw * scale, dh = ih * scale
        this.page.drawImage(img, {
          x: this.W - this.M - dw,
          y: this.H - hH + (hH - dh) / 2,
          width: dw, height: dh,
        })
      } catch { /* no logo */ }
    }

    // Document title — bold, white
    this.page.drawText(title, {
      x: this.M + 8, y: this.H - hH + (hH - 21) / 2 + 2,
      size: 21, font: this.bold, color: C.white,
    })

    this.y = this.H - hH - aH - 22
  }

  // ── Section header — dark navy background, white text ─────────────────────
  sectionHeader(label: string) {
    const h = 22
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: C.navyMid })
    this.page.drawText(label, {
      x: this.M + 11, y: this.y - 15,
      size: 8, font: this.bold, color: C.white,
    })
    this.y -= h
  }

  // ── Field renderer ─────────────────────────────────────────────────────────
  field(label: string, value: string, x: number, fy: number, w: number) {
    // Small all-caps label
    this.page.drawText(label.toUpperCase(), {
      x: x + 9, y: fy + this.rowH - this.lblSz - 5,
      size: this.lblSz, font: this.reg, color: C.label,
    })
    // Value
    const max = Math.floor((w - 18) / (this.valSz * 0.54))
    this.page.drawText((value || "—").slice(0, max), {
      x: x + 9, y: fy + 11,
      size: this.valSz, font: this.bold, color: C.dark,
    })
  }

  // ── Status badge renderer — inline pill in a field cell ───────────────────
  statusField(label: string, status: string, x: number, fy: number, w: number) {
    this.page.drawText(label.toUpperCase(), {
      x: x + 9, y: fy + this.rowH - this.lblSz - 5,
      size: this.lblSz, font: this.reg, color: C.label,
    })
    const colors = STATUS_COLORS[status]
    if (colors) {
      const [tr, tg, tb, br, bg_, bb] = colors
      const textColor = rgb(tr, tg, tb)
      const bgColor   = rgb(br, bg_, bb)
      const tw = this.bold.widthOfTextAtSize(status.toUpperCase(), 8) + 16
      this.page.drawRectangle({ x: x + 9, y: fy + 8, width: tw, height: 16, color: bgColor })
      this.page.drawText(status.toUpperCase(), { x: x + 17, y: fy + 13, size: 8, font: this.bold, color: textColor })
    } else {
      const max = Math.floor((w - 18) / (this.valSz * 0.54))
      this.page.drawText((status || "—").slice(0, max), { x: x + 9, y: fy + 11, size: this.valSz, font: this.bold, color: C.dark })
    }
  }

  // ── Row helpers ────────────────────────────────────────────────────────────
  private _rowBorder(fy: number) {
    this.page.drawLine({ start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy }, thickness: 0.5, color: C.border })
  }

  twoCol(l1: string, v1: string, f1: number, l2: string, v2: string, f2: number) {
    const w1 = Math.round(this.CW * f1 / (f1 + f2))
    const fy = this.y - this.rowH
    // Alternating row background
    this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: this.rowH, color: C.rowBg })
    this.field(l1, v1, this.M, fy, w1)
    this.field(l2, v2, this.M + w1, fy, this.CW - w1)
    // Vertical divider
    this.page.drawLine({ start: { x: this.M + w1, y: fy }, end: { x: this.M + w1, y: fy + this.rowH }, thickness: 0.5, color: C.border })
    this._rowBorder(fy)
    this.y -= this.rowH
  }

  // twoCol with a status badge in the second column
  twoColStatus(l1: string, v1: string, f1: number, l2: string, status: string, f2: number) {
    const w1 = Math.round(this.CW * f1 / (f1 + f2))
    const fy = this.y - this.rowH
    this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: this.rowH, color: C.rowBg })
    this.field(l1, v1, this.M, fy, w1)
    this.statusField(l2, status, this.M + w1, fy, this.CW - w1)
    this.page.drawLine({ start: { x: this.M + w1, y: fy }, end: { x: this.M + w1, y: fy + this.rowH }, thickness: 0.5, color: C.border })
    this._rowBorder(fy)
    this.y -= this.rowH
  }

  oneCol(label: string, value: string) {
    const fy = this.y - this.rowH
    this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: this.rowH, color: C.rowBg })
    this.field(label, value, this.M, fy, this.CW)
    this._rowBorder(fy)
    this.y -= this.rowH
  }

  // ── Text block (wrapping) ──────────────────────────────────────────────────
  textBlock(label: string, text: string) {
    if (!text?.trim()) return
    const fSize = 9.5, lineH = 16
    const maxChars = Math.floor(this.CW / (fSize * 0.52))
    const words = text.split(/\s+/)
    const lines: string[] = []
    let cur = ""
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (next.length <= maxChars) cur = next
      else { if (cur) lines.push(cur); cur = w }
    }
    if (cur) lines.push(cur)
    const blockH = Math.max(this.rowH + 10, lines.length * lineH + 28)
    this.sectionHeader(label)
    // Block background
    this.page.drawRectangle({ x: this.M, y: this.y - blockH, width: this.CW, height: blockH, color: C.rowBg })
    lines.forEach((line, i) =>
      this.page.drawText(line, { x: this.M + 11, y: this.y - 16 - i * lineH, size: fSize, font: this.reg, color: C.dark })
    )
    this._rowBorder(this.y - blockH)
    this.y -= blockH + 6
  }

  gap(n = 10) { this.y -= n }

  // ── Pricing block ─────────────────────────────────────────────────────────
  pricingBlock(amount: string, approved: boolean) {
    const h = 64
    const barColor  = approved ? C.green  : C.accent
    const textColor = approved ? C.green  : C.dark
    const bgColor   = approved ? C.greenLight : C.blueLight
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: bgColor })
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: 5, height: h, color: barColor })
    this.page.drawLine({ start: { x: this.M, y: this.y }, end: { x: this.M + this.CW, y: this.y }, thickness: 0.5, color: C.border })
    this._rowBorder(this.y - h)
    this.page.drawText("TOTAL CHANGE ORDER AMOUNT", { x: this.M + 16, y: this.y - 14, size: 6.5, font: this.reg, color: C.label })
    this.page.drawText(amount, { x: this.M + 16, y: this.y - 46, size: 26, font: this.bold, color: textColor })
    if (approved) {
      const badgeW = 84
      this.page.drawRectangle({ x: this.M + this.CW - badgeW - 12, y: this.y - h + 20, width: badgeW, height: 22, color: C.green })
      this.page.drawText("APPROVED", { x: this.M + this.CW - badgeW - 4, y: this.y - h + 28, size: 9, font: this.bold, color: C.white })
    }
    this.y -= h + 10
  }

  // ── Sign-off block ────────────────────────────────────────────────────────
  signatureLines(left: string, right: string) {
    const blockY = Math.max(this.y - 22, 128)
    const gap    = 14
    const cellW  = (this.CW - gap) / 2
    const cellH  = 72

    const drawCell = (x: number, label: string) => {
      // Cell background
      this.page.drawRectangle({ x, y: blockY - cellH, width: cellW, height: cellH, color: C.rowBg })
      // Navy top bar on cell
      this.page.drawRectangle({ x, y: blockY - 22, width: cellW, height: 22, color: C.navyMid })
      // Label in navy bar
      this.page.drawText(label.toUpperCase(), { x: x + 10, y: blockY - 15, size: 7, font: this.bold, color: C.white })
      // Border
      ;[
        [x, blockY - cellH, x + cellW, blockY - cellH],
        [x, blockY - cellH, x,         blockY        ],
        [x + cellW, blockY - cellH, x + cellW, blockY],
        [x, blockY, x + cellW, blockY],
      ].forEach(([x1, y1, x2, y2]) =>
        this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.75, color: C.border })
      )
      // Print name line
      const nl = blockY - cellH + 44
      this.page.drawLine({ start: { x: x + 12, y: nl }, end: { x: x + cellW - 12, y: nl }, thickness: 0.5, color: C.lgray })
      this.page.drawText("PRINT NAME", { x: x + 12, y: nl - 10, size: 6, font: this.reg, color: C.lgray })
      // Signature/date line
      const sl = blockY - cellH + 20
      this.page.drawLine({ start: { x: x + 12, y: sl }, end: { x: x + cellW - 60, y: sl }, thickness: 0.5, color: C.lgray })
      this.page.drawText("SIGNATURE", { x: x + 12, y: sl - 10, size: 6, font: this.reg, color: C.lgray })
      this.page.drawLine({ start: { x: x + cellW - 52, y: sl }, end: { x: x + cellW - 12, y: sl }, thickness: 0.5, color: C.accent })
      this.page.drawText("DATE", { x: x + cellW - 52, y: sl - 10, size: 6, font: this.reg, color: C.lgray })
    }

    drawCell(this.M, left)
    drawCell(this.M + cellW + gap, right)
  }

  // ── Table helpers (for revision history etc.) ─────────────────────────────
  tableHeader(headers: string[], colWidths: number[]) {
    const h = 22
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: C.navyMid })
    let cx = this.M
    headers.forEach((hdr, i) => {
      this.page.drawText(hdr.toUpperCase(), { x: cx + 8, y: this.y - 15, size: 6.5, font: this.bold, color: C.white })
      cx += colWidths[i]
    })
    this.y -= h
  }

  tableRow(vals: string[], colWidths: number[], highlight = false) {
    const h = 22
    if (highlight)
      this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: C.blueLight })
    else
      this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: C.rowBg })
    let cx = this.M
    vals.forEach((v, i) => {
      const max = Math.floor((colWidths[i] - 12) / (8 * 0.54))
      this.page.drawText(v.slice(0, max), {
        x: cx + 8, y: this.y - 15,
        size: 8, font: highlight ? this.bold : this.reg,
        color: highlight ? C.navy : C.dark,
      })
      cx += colWidths[i]
    })
    this._rowBorder(this.y - h)
    this.y -= h
  }

  // ── Save with footer ──────────────────────────────────────────────────────
  async save(): Promise<Uint8Array> {
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    // Footer rule
    this.page.drawLine({ start: { x: this.M, y: 34 }, end: { x: this.M + this.CW, y: 34 }, thickness: 0.5, color: C.border })
    this.page.drawText("Generated by TuttoHQ", { x: this.M, y: 20, size: 7, font: this.reg, color: C.footerGray })
    this.page.drawText(`Page 1 of 1  ·  ${today}`, { x: this.M + this.CW - 94, y: 20, size: 7, font: this.reg, color: C.footerGray })
    return this.doc.save()
  }
}
