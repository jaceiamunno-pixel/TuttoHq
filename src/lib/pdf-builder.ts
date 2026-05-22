import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFImage } from "pdf-lib"

// ─── Design tokens ────────────────────────────────────────────────────────────
// The shared TuttoHQ PDF design system. Steel-blue "coversheet" skin: clean
// label|value form cells, thin rules, a minimal header. Every generated PDF
// composes the building blocks below so they all look consistent.
export const PDF = {
  // Page geometry (points = 1/72 inch) — US Letter
  pageW: 612,
  pageH: 792,
  margin: 43,        // left/right margin (≈0.6in)
  topMargin: 36,     // top margin (≈0.5in)
  footerH: 30,       // footer band reserved at the bottom
  rowH: 22,          // standard form-row height
  get contentW() { return this.pageW - this.margin * 2 },   // 526

  color: {
    ink:        rgb(0.059, 0.090, 0.165),  // #0f172a — values
    label:      rgb(0.118, 0.161, 0.231),  // #1e293b — field labels
    fieldFill:  rgb(0.859, 0.906, 0.953),  // #dbe7f3 — steel-blue value cells
    rule:       rgb(0.796, 0.835, 0.882),  // #cbd5e1 — hairline rules
    ruleStrong: rgb(0.278, 0.337, 0.412),  // #475569 — section rules / borders
    muted:      rgb(0.580, 0.639, 0.722),  // #94a3b8 — secondary text
    accent:     rgb(0.114, 0.306, 0.847),  // #1d4ed8 — accent
    white:      rgb(1, 1, 1),
    green:      rgb(0.06, 0.46, 0.18),
    greenLight: rgb(0.88, 0.96, 0.90),
  },

  size: {
    title:   16,
    section: 8.5,
    label:   9.5,
    value:   10.5,
    body:    9.5,
    footer:  8.5,
  },
} as const

// Status badge color presets — [textR,textG,textB, bgR,bgG,bgB]
export const STATUS_COLORS: Record<string, [number, number, number, number, number, number]> = {
  Open:       [0.18, 0.44, 0.92,  0.88, 0.93, 0.99],
  Closed:     [0.06, 0.46, 0.18,  0.88, 0.96, 0.90],
  Approved:   [0.06, 0.46, 0.18,  0.88, 0.96, 0.90],
  Received:   [0.18, 0.44, 0.92,  0.88, 0.93, 0.99],
  Draft:      [0.48, 0.52, 0.62,  0.94, 0.95, 0.97],
  Pending:    [0.62, 0.38, 0.02,  0.99, 0.94, 0.84],
  Rejected:   [0.68, 0.09, 0.09,  0.98, 0.90, 0.90],
  Void:       [0.48, 0.52, 0.62,  0.94, 0.95, 0.97],
  High:       [0.68, 0.09, 0.09,  0.98, 0.90, 0.90],
  Medium:     [0.62, 0.38, 0.02,  0.99, 0.94, 0.84],
  Low:        [0.06, 0.46, 0.18,  0.88, 0.96, 0.90],
  Current:    [0.18, 0.44, 0.92,  0.88, 0.93, 0.99],
  Superseded: [0.48, 0.52, 0.62,  0.94, 0.95, 0.97],
}

// ─── Legacy navy palette ──────────────────────────────────────────────────────
// Retained so existing imports keep resolving during the migration. Routes that
// still reference `C` are restyled in later phases; this export is removed in the
// Phase 6 cleanup.
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

// ─── Public types ─────────────────────────────────────────────────────────────
export interface PDFDocMeta {
  /** Document type label shown in the header, e.g. "Change Order". */
  documentType: string
  /** Optional document identifier shown under the title, e.g. "CO-014". */
  documentNumber?: string | null
  /** Generation date — defaults to now. */
  generationDate?: Date
  /** Company logo bytes (PNG/JPG), drawn top-right on page 1. */
  logoBytes?: ArrayBuffer | null
}

/** Project metadata for the shared PDFProjectBlock. */
export interface PDFProjectInfo {
  name?: string | null
  number?: string | null
  location?: string | null
  gc_name?: string | null
  architect?: string | null
}

/** One cell in a PDFFieldGrid row. Provide `value` for plain text, or `status`
 *  to render a colored status badge. */
export interface FieldCell {
  label: string
  value?: string | null
  status?: string | null
}

/** A photo for PDFPhotoGrid. `bytes` is a pre-resized JPEG/PNG; `null` renders
 *  an "image unavailable" placeholder (e.g. an undecodable source file). */
export interface PDFPhoto {
  bytes: Uint8Array | null
  caption?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Truncate `text` with an ellipsis so it fits within `maxPx` at `size`. */
function clip(font: PDFFont, text: string, maxPx: number, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxPx) return text
  let s = text
  while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > maxPx) s = s.slice(0, -1)
  return s + "…"
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
}

// ─── PDFBuilder ───────────────────────────────────────────────────────────────
// Multi-page document engine. Compose a document by calling building-block
// methods (projectBlock, sectionDivider, fieldGrid, textBlock, table,
// signatureBlock, pricingBlock, photoGrid); the cursor auto-paginates and
// save() stamps the footer on every page.
export class PDFBuilder {
  doc!: PDFDocument
  bold!: PDFFont
  reg!: PDFFont

  private pages: PDFPage[] = []
  private page!: PDFPage
  private meta!: Required<Pick<PDFDocMeta, "documentType" | "generationDate">> & PDFDocMeta

  readonly W = PDF.pageW
  readonly H = PDF.pageH
  readonly M = PDF.margin
  readonly CW = PDF.contentW
  readonly rowH = PDF.rowH
  /** Lowest y a block may occupy before a page break is forced. */
  private readonly bottomLimit = PDF.footerH + 14

  /** Vertical cursor — top of the next block to be drawn. */
  y = 0

  // Table state — lets tableRow() redraw the header after a page break.
  private tHeaders: string[] | null = null
  private tColW: number[] | null = null

  private constructor() {}

  /** Create a builder. Accepts the structured meta object, or the legacy
   *  `(title, logoBytes)` signature used by not-yet-migrated routes. */
  static async create(meta: PDFDocMeta): Promise<PDFBuilder>
  static async create(title: string, logoBytes: ArrayBuffer | null): Promise<PDFBuilder>
  static async create(a: PDFDocMeta | string, b?: ArrayBuffer | null): Promise<PDFBuilder> {
    const meta: PDFDocMeta = typeof a === "string"
      ? { documentType: a, logoBytes: b ?? null }
      : a

    const builder = new PDFBuilder()
    builder.doc = await PDFDocument.create()
    builder.bold = await builder.doc.embedFont(StandardFonts.HelveticaBold)
    builder.reg = await builder.doc.embedFont(StandardFonts.Helvetica)
    builder.meta = {
      ...meta,
      documentType: meta.documentType,
      generationDate: meta.generationDate ?? new Date(),
    }

    builder.page = builder.doc.addPage([builder.W, builder.H])
    builder.pages.push(builder.page)
    await builder.drawHeader(true)
    return builder
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  /** Draw the page header. Page 1 gets the full header (title + logo + meta);
   *  continuation pages get a slim running header. */
  private async drawHeader(firstPage: boolean) {
    const top = this.H - PDF.topMargin

    if (firstPage) {
      // Title
      this.page.drawText(this.meta.documentType, {
        x: this.M, y: top - 15, size: PDF.size.title, font: this.bold, color: PDF.color.ink,
      })
      // Meta line — document number + generation date
      const metaParts: string[] = []
      if (this.meta.documentNumber) metaParts.push(String(this.meta.documentNumber))
      metaParts.push(`Generated ${fmtDate(this.meta.generationDate)}`)
      this.page.drawText(metaParts.join("   ·   "), {
        x: this.M, y: top - 30, size: PDF.size.footer, font: this.reg, color: PDF.color.muted,
      })
      // Logo — right-aligned, top-aligned with the title
      if (this.meta.logoBytes) {
        const img = await this.embedImage(this.meta.logoBytes)
        if (img) {
          const scale = Math.min(34 / img.height, 150 / img.width, 1)
          const dw = img.width * scale, dh = img.height * scale
          this.page.drawImage(img, { x: this.M + this.CW - dw, y: top - dh, width: dw, height: dh })
        }
      }
      // Header rule
      this.page.drawLine({
        start: { x: this.M, y: top - 42 }, end: { x: this.M + this.CW, y: top - 42 },
        thickness: 1, color: PDF.color.ruleStrong,
      })
      this.y = top - 42 - 14
    } else {
      const running = this.meta.documentNumber
        ? `${this.meta.documentType} — ${this.meta.documentNumber}`
        : this.meta.documentType
      this.page.drawText(running, {
        x: this.M, y: top - 9, size: 8, font: this.reg, color: PDF.color.muted,
      })
      this.page.drawLine({
        start: { x: this.M, y: top - 14 }, end: { x: this.M + this.CW, y: top - 14 },
        thickness: 0.5, color: PDF.color.rule,
      })
      this.y = top - 14 - 12
    }
  }

  private async embedImage(bytes: ArrayBuffer | Uint8Array): Promise<PDFImage | null> {
    try { return await this.doc.embedPng(bytes) }
    catch {
      try { return await this.doc.embedJpg(bytes) }
      catch { return null }
    }
  }

  // ── Page flow ───────────────────────────────────────────────────────────────
  /** Start a new page and draw its running header. */
  pageBreak() {
    this.page = this.doc.addPage([this.W, this.H])
    this.pages.push(this.page)
    // drawHeader(false) is sync in practice (no logo on continuation pages).
    void this.drawHeader(false)
  }

  /** Force a page break if `needed` points won't fit above the footer. */
  private ensureSpace(needed: number) {
    if (this.y - needed < this.bottomLimit) this.pageBreak()
  }

  /** Advance the cursor down by `pt` points. */
  spacer(pt = 10) { this.y -= pt }

  // ── Field cell primitive ────────────────────────────────────────────────────
  /** Draw one label|value (or label|status-badge) form cell. */
  private drawFieldCell(
    x: number, fy: number, w: number, label: string,
    value?: string | null, status?: string | null,
  ) {
    const lw = Math.min(118, Math.floor(w * 0.42))
    const vw = w - lw
    this.page.drawRectangle({ x, y: fy, width: lw, height: this.rowH, color: PDF.color.white })
    this.page.drawRectangle({ x: x + lw, y: fy, width: vw, height: this.rowH, color: PDF.color.fieldFill })
    this.page.drawText(clip(this.bold, label, lw - 10, PDF.size.label), {
      x: x + 6, y: fy + 7, size: PDF.size.label, font: this.bold, color: PDF.color.label,
    })
    if (status != null && status !== "") {
      this.drawBadge(x + lw + 6, fy, String(status))
    } else {
      this.page.drawText(clip(this.reg, value && value !== "" ? value : "—", vw - 12, PDF.size.value), {
        x: x + lw + 6, y: fy + 7, size: PDF.size.value, font: this.reg, color: PDF.color.ink,
      })
    }
  }

  /** Draw a colored status pill at the given cell origin. */
  private drawBadge(x: number, fy: number, status: string) {
    const txt = status.toUpperCase()
    const preset = STATUS_COLORS[status]
    if (!preset) {
      this.page.drawText(clip(this.reg, status, this.CW * 0.3, PDF.size.value), {
        x, y: fy + 7, size: PDF.size.value, font: this.reg, color: PDF.color.ink,
      })
      return
    }
    const [tr, tg, tb, br, bg, bb] = preset
    const tw = this.bold.widthOfTextAtSize(txt, 7.5) + 14
    this.page.drawRectangle({ x, y: fy + 4, width: tw, height: 14, color: rgb(br, bg, bb) })
    this.page.drawText(txt, { x: x + 7, y: fy + 8, size: 7.5, font: this.bold, color: rgb(tr, tg, tb) })
  }

  /** Draw a row of 1–3 cells with the given flex fractions, plus rules. */
  private drawCellRow(cells: (FieldCell & { frac: number })[]) {
    const fy = this.y - this.rowH
    const totalFrac = cells.reduce((s, c) => s + c.frac, 0)
    let cx = this.M
    cells.forEach((c, i) => {
      const last = i === cells.length - 1
      const w = last ? this.M + this.CW - cx : Math.round(this.CW * c.frac / totalFrac)
      this.drawFieldCell(cx, fy, w, c.label, c.value, c.status)
      if (i > 0) {
        this.page.drawLine({
          start: { x: cx, y: fy }, end: { x: cx, y: fy + this.rowH },
          thickness: 0.5, color: PDF.color.rule,
        })
      }
      cx += w
    })
    this.page.drawLine({
      start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy },
      thickness: 0.5, color: PDF.color.rule,
    })
    this.y -= this.rowH
  }

  /** Outer border around a block whose top edge was at `topY`. */
  private blockBorder(topY: number) {
    const corners: [number, number, number, number][] = [
      [this.M, topY, this.M + this.CW, topY],
      [this.M, this.y, this.M + this.CW, this.y],
      [this.M, this.y, this.M, topY],
      [this.M + this.CW, this.y, this.M + this.CW, topY],
    ]
    for (const [x1, y1, x2, y2] of corners) {
      this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.75, color: PDF.color.rule })
    }
  }

  // ── PDFProjectBlock ─────────────────────────────────────────────────────────
  /** Render project metadata as a bordered form block. */
  projectBlock(project: PDFProjectInfo) {
    const rows: (FieldCell & { frac: number })[][] = [
      [{ label: "Project Name", value: project.name, frac: 1 }],
      [{ label: "Project Number", value: project.number, frac: 1 }],
    ]
    if (project.location) rows.push([{ label: "Project Location", value: project.location, frac: 1 }])
    if (project.gc_name || project.architect) {
      rows.push([
        { label: "General Contractor", value: project.gc_name, frac: 1 },
        { label: "Architect", value: project.architect, frac: 1 },
      ])
    }
    this.ensureSpace(rows.length * this.rowH)
    const topY = this.y
    for (const row of rows) this.drawCellRow(row)
    this.blockBorder(topY)
    this.spacer(6)
  }

  // ── PDFSectionDivider ───────────────────────────────────────────────────────
  /** Thin section separator with an optional small-caps title. */
  sectionDivider(title?: string) {
    this.spacer(8)
    this.ensureSpace(20)
    if (title) {
      this.page.drawText(title.toUpperCase(), {
        x: this.M, y: this.y - 9, size: PDF.size.section, font: this.bold, color: PDF.color.ruleStrong,
      })
    }
    this.page.drawLine({
      start: { x: this.M, y: this.y - 14 }, end: { x: this.M + this.CW, y: this.y - 14 },
      thickness: 1, color: PDF.color.ruleStrong,
    })
    this.y -= 14 + 8
  }

  // ── PDFFieldGrid ────────────────────────────────────────────────────────────
  /** Render rows of key-value cells as a bordered form block. Each inner array
   *  is one row of 1–3 cells; columns within a row split the width evenly. */
  fieldGrid(rows: FieldCell[][]) {
    if (rows.length === 0) return
    this.ensureSpace(rows.length * this.rowH)
    const topY = this.y
    for (const row of rows) {
      this.drawCellRow(row.map(c => ({ ...c, frac: 1 })))
    }
    this.blockBorder(topY)
    this.spacer(6)
  }

  // ── Text block ──────────────────────────────────────────────────────────────
  /** A titled, word-wrapped paragraph. Wraps across pages as needed. */
  textBlock(title: string, body?: string | null) {
    if (!body || !body.trim()) return
    this.sectionDivider(title)
    const lineH = 15
    for (const line of this.wrapText(body.trim(), PDF.size.body, this.CW)) {
      this.ensureSpace(lineH)
      this.page.drawText(line, {
        x: this.M, y: this.y - 11, size: PDF.size.body, font: this.reg, color: PDF.color.ink,
      })
      this.y -= lineH
    }
    this.spacer(4)
  }

  private wrapText(text: string, size: number, maxW: number): string[] {
    const lines: string[] = []
    for (const paragraph of text.split(/\r?\n/)) {
      const words = paragraph.split(/\s+/).filter(Boolean)
      let cur = ""
      for (const word of words) {
        const next = cur ? `${cur} ${word}` : word
        if (this.reg.widthOfTextAtSize(next, size) <= maxW) {
          cur = next
        } else {
          if (cur) lines.push(cur)
          cur = word
        }
      }
      lines.push(cur)
    }
    return lines
  }

  // ── Table ───────────────────────────────────────────────────────────────────
  /** Draw a table header row and remember it so rows can repeat it after a
   *  page break. */
  tableHeader(headers: string[], colWidths: number[]) {
    this.tHeaders = headers
    this.tColW = colWidths
    this.drawTableHeaderRow()
  }

  private drawTableHeaderRow() {
    if (!this.tHeaders || !this.tColW) return
    const h = 20
    this.ensureSpace(h)
    const fy = this.y - h
    this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: h, color: PDF.color.fieldFill })
    let cx = this.M
    this.tHeaders.forEach((hdr, i) => {
      this.page.drawText(clip(this.bold, hdr.toUpperCase(), this.tColW![i] - 12, 7.5), {
        x: cx + 7, y: fy + 7, size: 7.5, font: this.bold, color: PDF.color.ruleStrong,
      })
      cx += this.tColW![i]
    })
    this.page.drawLine({
      start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy },
      thickness: 0.75, color: PDF.color.ruleStrong,
    })
    this.y -= h
  }

  /** Draw one table data row. Repeats the header automatically on a new page. */
  tableRow(values: string[], colWidths: number[], highlight = false) {
    const h = 20
    if (this.y - h < this.bottomLimit) {
      this.pageBreak()
      this.drawTableHeaderRow()
    }
    const fy = this.y - h
    if (highlight) {
      this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: h, color: PDF.color.fieldFill })
    }
    let cx = this.M
    values.forEach((v, i) => {
      this.page.drawText(clip(highlight ? this.bold : this.reg, v ?? "—", colWidths[i] - 12, 8), {
        x: cx + 7, y: fy + 7, size: 8,
        font: highlight ? this.bold : this.reg, color: PDF.color.ink,
      })
      cx += colWidths[i]
    })
    this.page.drawLine({
      start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy },
      thickness: 0.5, color: PDF.color.rule,
    })
    this.y -= h
  }

  /** Convenience: draw a full table from headers + rows in one call. */
  table(headers: string[], rows: string[][], colWidths: number[], highlightRow?: (row: string[]) => boolean) {
    this.tableHeader(headers, colWidths)
    for (const row of rows) this.tableRow(row, colWidths, highlightRow?.(row) ?? false)
    this.spacer(4)
  }

  // ── Pricing block ───────────────────────────────────────────────────────────
  /** Emphasized total-amount block (used by change orders). */
  pricingBlock(amount: string, approved: boolean) {
    this.spacer(6)
    const h = 60
    this.ensureSpace(h + 6)
    const fy = this.y - h
    const barColor = approved ? PDF.color.green : PDF.color.accent
    const bgColor = approved ? PDF.color.greenLight : PDF.color.fieldFill
    this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: h, color: bgColor })
    this.page.drawRectangle({ x: this.M, y: fy, width: 5, height: h, color: barColor })
    this.blockBorder(this.y)
    this.page.drawText("TOTAL AMOUNT", {
      x: this.M + 16, y: fy + h - 16, size: 7, font: this.reg, color: PDF.color.label,
    })
    this.page.drawText(amount, {
      x: this.M + 16, y: fy + 14, size: 24, font: this.bold,
      color: approved ? PDF.color.green : PDF.color.ink,
    })
    if (approved) {
      const bw = 78
      this.page.drawRectangle({ x: this.M + this.CW - bw - 14, y: fy + h - 30, width: bw, height: 18, color: PDF.color.green })
      this.page.drawText("APPROVED", {
        x: this.M + this.CW - bw - 5, y: fy + h - 25, size: 8.5, font: this.bold, color: PDF.color.white,
      })
    }
    this.y -= h
  }

  // ── Signature block ─────────────────────────────────────────────────────────
  /** Two side-by-side sign-off cells (print name / signature / date). */
  signatureBlock(leftLabel: string, rightLabel: string) {
    this.spacer(16)
    const cellH = 70
    this.ensureSpace(cellH + 6)
    const gap = 14
    const cellW = (this.CW - gap) / 2
    const fy = this.y - cellH

    const drawCell = (x: number, label: string) => {
      this.page.drawRectangle({ x, y: fy, width: cellW, height: cellH, color: PDF.color.white })
      this.page.drawText(label.toUpperCase(), {
        x: x + 4, y: fy + cellH + 5, size: 7, font: this.bold, color: PDF.color.ruleStrong,
      })
      const border: [number, number, number, number][] = [
        [x, fy, x + cellW, fy],
        [x, fy + cellH, x + cellW, fy + cellH],
        [x, fy, x, fy + cellH],
        [x + cellW, fy, x + cellW, fy + cellH],
      ]
      for (const [x1, y1, x2, y2] of border) {
        this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.75, color: PDF.color.rule })
      }
      // Print-name line
      const nameY = fy + 42
      this.page.drawLine({ start: { x: x + 12, y: nameY }, end: { x: x + cellW - 12, y: nameY }, thickness: 0.5, color: PDF.color.muted })
      this.page.drawText("PRINT NAME", { x: x + 12, y: nameY - 10, size: 6, font: this.reg, color: PDF.color.muted })
      // Signature + date line
      const sigY = fy + 16
      this.page.drawLine({ start: { x: x + 12, y: sigY }, end: { x: x + cellW - 64, y: sigY }, thickness: 0.5, color: PDF.color.muted })
      this.page.drawText("SIGNATURE", { x: x + 12, y: sigY - 10, size: 6, font: this.reg, color: PDF.color.muted })
      this.page.drawLine({ start: { x: x + cellW - 56, y: sigY }, end: { x: x + cellW - 12, y: sigY }, thickness: 0.5, color: PDF.color.accent })
      this.page.drawText("DATE", { x: x + cellW - 56, y: sigY - 10, size: 6, font: this.reg, color: PDF.color.muted })
    }

    drawCell(this.M, leftLabel)
    drawCell(this.M + cellW + gap, rightLabel)
    this.y -= cellH
  }

  // ── PDFPhotoGrid ────────────────────────────────────────────────────────────
  /** Lay out photos in a 2×2 grid, 4 per page, auto-paginating. Each photo is
   *  letterboxed to its aspect ratio with a caption strip below. */
  async photoGrid(photos: PDFPhoto[]) {
    if (photos.length === 0) return
    const perPage = 4
    const cols = 2
    const gap = 12
    const cellW = (this.CW - gap) / 2

    for (let i = 0; i < photos.length; i += perPage) {
      if (i > 0) {
        this.pageBreak()
        this.sectionDivider("Site Photos (cont.)")
      }
      const top = this.y
      const cellH = (top - this.bottomLimit - gap) / 2
      const slice = photos.slice(i, i + perPage)
      for (let j = 0; j < slice.length; j++) {
        const r = Math.floor(j / cols)
        const c = j % cols
        const cx = this.M + c * (cellW + gap)
        const cy = top - r * (cellH + gap) - cellH
        await this.drawPhotoCell(cx, cy, cellW, cellH, slice[j])
      }
      this.y = top - 2 * cellH - gap
    }
  }

  private async drawPhotoCell(x: number, y: number, w: number, h: number, photo: PDFPhoto) {
    const capH = 16
    const imgAreaH = h - capH
    const pad = 6
    this.page.drawRectangle({ x, y, width: w, height: h, color: PDF.color.white, borderColor: PDF.color.rule, borderWidth: 0.75 })
    this.page.drawLine({ start: { x, y: y + capH }, end: { x: x + w, y: y + capH }, thickness: 0.5, color: PDF.color.rule })

    let drawn = false
    if (photo.bytes) {
      const img = await this.embedImage(photo.bytes)
      if (img) {
        const scale = Math.min((w - pad * 2) / img.width, (imgAreaH - pad * 2) / img.height)
        const dw = img.width * scale, dh = img.height * scale
        this.page.drawImage(img, {
          x: x + (w - dw) / 2, y: y + capH + (imgAreaH - dh) / 2, width: dw, height: dh,
        })
        drawn = true
      }
    }
    if (!drawn) {
      const msg = "Image unavailable"
      const mw = this.reg.widthOfTextAtSize(msg, 8)
      this.page.drawText(msg, {
        x: x + (w - mw) / 2, y: y + capH + imgAreaH / 2 - 4, size: 8, font: this.reg, color: PDF.color.muted,
      })
    }
    if (photo.caption) {
      this.page.drawText(clip(this.reg, photo.caption, w - 12, 7.5), {
        x: x + 6, y: y + 5, size: 7.5, font: this.reg, color: PDF.color.label,
      })
    }
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  /** Stamp the footer on every page and serialize the document. */
  async save(): Promise<Uint8Array> {
    const total = this.pages.length
    const dateStr = fmtDate(this.meta.generationDate)
    this.pages.forEach((pg, i) => {
      pg.drawLine({
        start: { x: this.M, y: PDF.footerH + 4 }, end: { x: this.M + this.CW, y: PDF.footerH + 4 },
        thickness: 0.5, color: PDF.color.rule,
      })
      pg.drawText("Generated by TuttoHQ", {
        x: this.M, y: PDF.footerH - 8, size: PDF.size.footer, font: this.bold, color: PDF.color.label,
      })
      const pageStr = `Page ${i + 1} of ${total}`
      const pw = this.reg.widthOfTextAtSize(pageStr, PDF.size.footer)
      pg.drawText(pageStr, {
        x: this.M + (this.CW - pw) / 2, y: PDF.footerH - 8, size: PDF.size.footer, font: this.reg, color: PDF.color.label,
      })
      const dw = this.reg.widthOfTextAtSize(dateStr, PDF.size.footer)
      pg.drawText(dateStr, {
        x: this.M + this.CW - dw, y: PDF.footerH - 8, size: PDF.size.footer, font: this.reg, color: PDF.color.muted,
      })
    })
    return this.doc.save()
  }

  // ── Backward-compat shims ─────────────────────────────────────────────────────
  // Thin wrappers preserving the pre-overhaul API so not-yet-migrated routes keep
  // compiling and render in the new skin. Removed in the Phase 6 cleanup.

  /** @deprecated use {@link sectionDivider}. */
  sectionHeader(label: string) { this.sectionDivider(label) }

  /** @deprecated use {@link spacer}. */
  gap(n = 10) { this.spacer(n) }

  /** @deprecated use {@link fieldGrid}. */
  oneCol(label: string, value: string) {
    this.ensureSpace(this.rowH)
    const topY = this.y
    this.drawCellRow([{ label, value, frac: 1 }])
    this.blockBorder(topY)
  }

  /** @deprecated use {@link fieldGrid}. */
  twoCol(l1: string, v1: string, f1: number, l2: string, v2: string, f2: number) {
    this.ensureSpace(this.rowH)
    const topY = this.y
    this.drawCellRow([{ label: l1, value: v1, frac: f1 }, { label: l2, value: v2, frac: f2 }])
    this.blockBorder(topY)
  }

  /** @deprecated use {@link fieldGrid} with a `status` cell. */
  twoColStatus(l1: string, v1: string, f1: number, l2: string, status: string, f2: number) {
    this.ensureSpace(this.rowH)
    const topY = this.y
    this.drawCellRow([{ label: l1, value: v1, frac: f1 }, { label: l2, status, frac: f2 }])
    this.blockBorder(topY)
  }

  /** @deprecated use {@link signatureBlock}. */
  signatureLines(left: string, right: string) { this.signatureBlock(left, right) }
}
