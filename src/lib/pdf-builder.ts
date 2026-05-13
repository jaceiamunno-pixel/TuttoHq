import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib"

export const C = {
  navy:    rgb(0.08, 0.14, 0.30),
  accent:  rgb(0.20, 0.46, 0.94),
  lightBg: rgb(0.96, 0.97, 0.99),
  dark:    rgb(0.10, 0.10, 0.14),
  label:   rgb(0.42, 0.46, 0.56),
  border:  rgb(0.87, 0.90, 0.94),
  white:   rgb(1, 1, 1),
  lgray:   rgb(0.75, 0.77, 0.80),
  green:   rgb(0.08, 0.50, 0.22),
  red:     rgb(0.72, 0.12, 0.12),
  amber:   rgb(0.68, 0.42, 0.04),
  footerGray: rgb(0.58, 0.60, 0.64),
}

export class PDFBuilder {
  doc!: PDFDocument
  page!: PDFPage
  bold!: PDFFont
  reg!: PDFFont
  W = 612; H = 792; M = 44
  get CW() { return this.W - this.M * 2 }
  y = 0
  rowH = 38; lblSz = 6.5; valSz = 10.5

  private constructor() {}

  static async create(title: string, logoBytes: ArrayBuffer | null): Promise<PDFBuilder> {
    const b = new PDFBuilder()
    b.doc  = await PDFDocument.create()
    b.bold = await b.doc.embedFont(StandardFonts.HelveticaBold)
    b.reg  = await b.doc.embedFont(StandardFonts.Helvetica)
    b.page = b.doc.addPage([b.W, b.H])
    await b._drawHeader(title, logoBytes)
    return b
  }

  private async _drawHeader(title: string, logoBytes: ArrayBuffer | null) {
    const headerH = 72, accentH = 4
    this.page.drawRectangle({ x: 0, y: this.H - headerH, width: this.W, height: headerH, color: C.navy })
    this.page.drawRectangle({ x: 0, y: this.H - headerH - accentH, width: this.W, height: accentH, color: C.accent })

    if (logoBytes) {
      try {
        const img = await (async () => { try { return await this.doc.embedPng(logoBytes) } catch { return await this.doc.embedJpg(logoBytes) } })()
        const { width: iw, height: ih } = img.scale(1)
        const scale = Math.min(44 / ih, 120 / iw, 1)
        this.page.drawImage(img, { x: this.W - this.M - iw * scale, y: this.H - headerH + (headerH - ih * scale) / 2, width: iw * scale, height: ih * scale })
      } catch { /* skip */ }
    }

    this.page.drawText(title, { x: this.M, y: this.H - headerH + (headerH - 20) / 2, size: 20, font: this.bold, color: C.white })
    this.y = this.H - headerH - accentH - 22
  }

  sectionHeader(label: string) {
    const h = 24
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: C.lightBg })
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: 4, height: h, color: C.accent })
    this.page.drawText(label, { x: this.M + 14, y: this.y - 16, size: 8.5, font: this.bold, color: C.navy })
    this.y -= h + 2
  }

  field(label: string, value: string, x: number, fy: number, w: number) {
    this.page.drawText(label.toUpperCase(), { x: x + 7, y: fy + this.rowH - this.lblSz - 4, size: this.lblSz, font: this.reg, color: C.label })
    const max = Math.floor((w - 14) / (this.valSz * 0.56))
    this.page.drawText((value || "—").slice(0, max), { x: x + 7, y: fy + 9, size: this.valSz, font: this.bold, color: C.dark })
  }

  twoCol(l1: string, v1: string, f1: number, l2: string, v2: string, f2: number) {
    const w1 = Math.round(this.CW * f1 / (f1 + f2))
    const fy  = this.y - this.rowH
    this.field(l1, v1, this.M, fy, w1)
    this.field(l2, v2, this.M + w1, fy, this.CW - w1)
    this.page.drawLine({ start: { x: this.M + w1, y: fy }, end: { x: this.M + w1, y: fy + this.rowH }, thickness: 0.5, color: C.border })
    this.page.drawLine({ start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy }, thickness: 0.5, color: C.border })
    this.y -= this.rowH
  }

  oneCol(label: string, value: string) {
    const fy = this.y - this.rowH
    this.field(label, value, this.M, fy, this.CW)
    this.page.drawLine({ start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy }, thickness: 0.5, color: C.border })
    this.y -= this.rowH
  }

  textBlock(label: string, text: string) {
    if (!text?.trim()) return
    const maxChars = Math.floor(this.CW / (9 * 0.52))
    const words = text.split(/\s+/)
    const lines: string[] = []
    let cur = ""
    for (const w of words) {
      if ((cur + (cur ? " " : "") + w).length <= maxChars) cur += (cur ? " " : "") + w
      else { if (cur) lines.push(cur); cur = w }
    }
    if (cur) lines.push(cur)
    const blockH = Math.max(this.rowH, lines.length * 15 + 22)
    this.sectionHeader(label)
    lines.forEach((line, i) => this.page.drawText(line, { x: this.M + 14, y: this.y - 14 - i * 15, size: 9, font: this.reg, color: C.dark }))
    this.page.drawLine({ start: { x: this.M, y: this.y - blockH }, end: { x: this.M + this.CW, y: this.y - blockH }, thickness: 0.5, color: C.border })
    this.y -= blockH + 8
  }

  gap(n = 10) { this.y -= n }

  pricingBlock(amount: string, approved: boolean) {
    const h = 52
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.CW, height: h, color: C.lightBg })
    this.page.drawRectangle({ x: this.M, y: this.y - h, width: 4, height: h, color: approved ? C.green : C.accent })
    this.page.drawText("TOTAL CHANGE ORDER AMOUNT", { x: this.M + 14, y: this.y - 16, size: 7, font: this.reg, color: C.label })
    this.page.drawText(amount, { x: this.M + 14, y: this.y - 38, size: 22, font: this.bold, color: approved ? C.green : C.dark })
    this.page.drawLine({ start: { x: this.M, y: this.y - h }, end: { x: this.M + this.CW, y: this.y - h }, thickness: 0.5, color: C.border })
    this.y -= h + 8
  }

  statusBadge(status: string, colorMap: Record<string, [number, number, number]>) {
    const rgb3 = colorMap[status] ?? [0.42, 0.46, 0.56]
    const color = rgb(rgb3[0], rgb3[1], rgb3[2])
    const tw = this.bold.widthOfTextAtSize(status, 8) + 16
    this.page.drawRectangle({ x: this.M, y: this.y - 22, width: tw, height: 18, color })
    this.page.drawText(status.toUpperCase(), { x: this.M + 8, y: this.y - 16, size: 8, font: this.bold, color: C.white })
    this.y -= 30
  }

  signatureLines(left: string, right: string) {
    const sigY = Math.max(this.y - 20, 88)
    this.page.drawLine({ start: { x: this.M, y: sigY }, end: { x: this.M + 190, y: sigY }, thickness: 0.5, color: C.lgray })
    this.page.drawText(left, { x: this.M, y: sigY - 14, size: 7, font: this.reg, color: C.label })
    this.page.drawLine({ start: { x: this.M + 230, y: sigY }, end: { x: this.M + this.CW, y: sigY }, thickness: 0.5, color: C.lgray })
    this.page.drawText(right, { x: this.M + 230, y: sigY - 14, size: 7, font: this.reg, color: C.label })
  }

  async save(): Promise<Uint8Array> {
    // Footer
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    this.page.drawLine({ start: { x: this.M, y: 30 }, end: { x: this.M + this.CW, y: 30 }, thickness: 0.5, color: C.border })
    this.page.drawText("Generated by TuttoHQ", { x: this.M, y: 16, size: 7, font: this.reg, color: C.footerGray })
    this.page.drawText(today, { x: this.M + this.CW - 50, y: 16, size: 7, font: this.reg, color: C.footerGray })
    return this.doc.save()
  }
}
