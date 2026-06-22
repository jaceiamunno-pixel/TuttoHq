import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFImage } from "pdf-lib"
import { clampLogoScalePct } from "./logo-scale"

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
    highlight:  rgb(1, 0.965, 0.55),       // THP-style yellow for subtotal/total cells
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
  /** Company name — drawn top-right in place of the logo when no logo is set. */
  brandName?: string | null
  /** Max rendered height (pt) of the header logo. Defaults to 34 (compact mark).
   *  Set larger (e.g. the coversheet's square seal) to fill the header band; when
   *  set, the logo is also vertically centered on the title block instead of
   *  top-aligned. Width is always capped at 150pt regardless. */
  logoMaxH?: number
  /** Per-tenant logo size as a PERCENT multiplier on the base height above
   *  (company_settings.logo_scale_pct). Clamped 50–200; missing → 130. The 150pt
   *  width cap is NOT scaled (distortion guard). */
  logoScalePct?: number
  /** Page orientation. "landscape" swaps width/height — used for wide,
   *  many-column log tables (Submittal Log, Change-Order log). Default portrait. */
  orientation?: "portrait" | "landscape"
  /** Skip the standard header entirely (for letter-style docs that draw their
   *  own letterhead, e.g. the PCO cover). */
  noHeader?: boolean
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

/** A checkbox within a PDFFieldGrid checkbox row. */
export interface PDFCheckbox {
  label: string
  checked: boolean
}

/** A PDFFieldGrid row — either key-value cells, or a row of checkboxes. */
export type PDFGridRow = FieldCell[] | { checkboxes: PDFCheckbox[] }

/** A review-stamp box for PDFStampGrid. */
export interface PDFStamp {
  role: string
  content?: string | null
}

/** OUR review stamp, rendered into the top-left box of PDFStampGrid. All fields
 *  are pre-resolved server-side; empty strings render as a graceful "—" (or are
 *  omitted, for `submittalNo`). */
export interface PDFReviewerStamp {
  /** Company name shown right-aligned in the red header bar. */
  company: string
  projectName: string
  projectNumber: string
  /** Pre-formatted "{section}-{num}.{rev}"; pass "" to omit the row entirely. */
  submittalNo: string
  reviewedBy: string
  /** Generation date, pre-formatted M/D/YYYY. */
  date: string
  /** Review-language boilerplate paragraph (small print). */
  reviewText: string
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

  // W / H / CW are set in create() — landscape swaps the page dimensions. The
  // initializers are the portrait defaults.
  W: number = PDF.pageW
  H: number = PDF.pageH
  readonly M = PDF.margin
  CW: number = PDF.contentW
  readonly rowH = PDF.rowH
  /** Lowest y a block may occupy before a page break is forced. */
  private readonly bottomLimit = PDF.footerH + 14

  /** Vertical cursor — top of the next block to be drawn. */
  y = 0

  // Table state — lets tableRow() redraw the header after a page break.
  private tHeaders: string[] | null = null
  private tColW: number[] | null = null

  private constructor() {}

  /** Create a builder for a new document. */
  static async create(meta: PDFDocMeta): Promise<PDFBuilder> {
    const builder = new PDFBuilder()
    builder.doc = await PDFDocument.create()
    builder.bold = await builder.doc.embedFont(StandardFonts.HelveticaBold)
    builder.reg = await builder.doc.embedFont(StandardFonts.Helvetica)
    builder.meta = {
      ...meta,
      documentType: meta.documentType,
      generationDate: meta.generationDate ?? new Date(),
    }

    // Landscape swaps width/height; content width follows. Must run before the
    // first page is added so every page (and the header/footer math) uses it.
    if (meta.orientation === "landscape") {
      builder.W = PDF.pageH
      builder.H = PDF.pageW
      builder.CW = builder.W - PDF.margin * 2
    }

    builder.page = builder.doc.addPage([builder.W, builder.H])
    builder.pages.push(builder.page)
    if (meta.noHeader) builder.y = builder.H - PDF.topMargin
    else await builder.drawHeader(true)
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
      // Logo — right-aligned, top-aligned with the title. When no logo is
      // available, the company name is drawn there instead.
      let logoDrawn = false
      if (this.meta.logoBytes) {
        const img = await this.embedImage(this.meta.logoBytes)
        if (img) {
          // Height capped at logoMaxH (default 34) scaled by the tenant's
          // logo_scale_pct; width always capped at 150 so a wide wordmark can't
          // reach the title. min(...,1) keeps it from upscaling past native
          // resolution.
          const baseMaxH = this.meta.logoMaxH ?? 34
          const maxH = baseMaxH * (clampLogoScalePct(this.meta.logoScalePct) / 100)
          const scale = Math.min(maxH / img.height, 150 / img.width, 1)
          const dw = img.width * scale, dh = img.height * scale
          // Default: top-aligned with the title. With an enlarged logo, center it
          // on the title + subtitle block (title baseline top-15, subtitle
          // baseline top-30 → block center ≈ top-17) so the seal sits balanced
          // against the title and still clears the header rule at top-42.
          const y = this.meta.logoMaxH ? (top - 17) - dh / 2 : top - dh
          this.page.drawImage(img, { x: this.M + this.CW - dw, y, width: dw, height: dh })
          logoDrawn = true
        }
      }
      if (!logoDrawn && this.meta.brandName) {
        const nw = this.bold.widthOfTextAtSize(this.meta.brandName, 13)
        this.page.drawText(this.meta.brandName, {
          x: this.M + this.CW - nw, y: top - 14, size: 13, font: this.bold, color: PDF.color.ink,
        })
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
      catch (err) {
        console.error("[pdf-builder] failed to embed image as PNG or JPG", err)
        return null
      }
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
  /** Value-line height inside a form field cell. */
  private readonly fieldLineH = PDF.size.value + 3

  /** The cell width split — label gutter + value area — for a cell of width `w`. */
  private fieldCellSplit(w: number): { lw: number; vw: number } {
    const lw = Math.min(118, Math.floor(w * 0.42))
    return { lw, vw: w - lw }
  }

  /** Draw one label|value (or label|status-badge) form cell of height `h`. The
   *  value wraps across as many lines as `h` allows (the row was sized to fit);
   *  the label stays single-line (labels are short, fixed strings). */
  private drawFieldCell(
    x: number, fy: number, w: number, h: number, label: string,
    value?: string | null, status?: string | null,
  ) {
    const { lw, vw } = this.fieldCellSplit(w)
    this.page.drawRectangle({ x, y: fy, width: lw, height: h, color: PDF.color.white })
    this.page.drawRectangle({ x: x + lw, y: fy, width: vw, height: h, color: PDF.color.fieldFill })
    // Anchor the label + first value line to the top so single-line rows render
    // identically to before (h === rowH ⇒ baseline at fy + 7).
    const topBaseline = fy + h - 15
    this.page.drawText(clip(this.bold, label, lw - 10, PDF.size.label), {
      x: x + 6, y: topBaseline, size: PDF.size.label, font: this.bold, color: PDF.color.label,
    })
    if (status != null && status !== "") {
      this.drawBadge(x + lw + 6, fy + h - this.rowH, String(status))
    } else {
      let ly = topBaseline
      for (const line of this.wrapTextWith(this.reg, value && value !== "" ? value : "—", PDF.size.value, vw - 12)) {
        this.page.drawText(line, { x: x + lw + 6, y: ly, size: PDF.size.value, font: this.reg, color: PDF.color.ink })
        ly -= this.fieldLineH
      }
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

  /** Resolve each cell's pixel width for a row, honoring flex fractions. The
   *  last cell absorbs rounding so the row always spans the full content width. */
  private cellRowWidths(cells: (FieldCell & { frac: number })[]): number[] {
    const totalFrac = cells.reduce((s, c) => s + c.frac, 0)
    const widths: number[] = []
    let cx = this.M
    cells.forEach((c, i) => {
      const last = i === cells.length - 1
      const w = last ? this.M + this.CW - cx : Math.round(this.CW * c.frac / totalFrac)
      widths.push(w)
      cx += w
    })
    return widths
  }

  /** Height a cell row needs so its longest value wraps fully. One line ⇒ rowH
   *  (unchanged); each extra line adds one value-line height. */
  private cellRowHeight(cells: (FieldCell & { frac: number })[]): number {
    const widths = this.cellRowWidths(cells)
    let maxLines = 1
    cells.forEach((c, i) => {
      if (c.status != null && c.status !== "") return  // badge — always one line
      const { vw } = this.fieldCellSplit(widths[i])
      const lines = this.wrapTextWith(this.reg, c.value && c.value !== "" ? c.value : "—", PDF.size.value, vw - 12)
      if (lines.length > maxLines) maxLines = lines.length
    })
    return this.rowH + (maxLines - 1) * this.fieldLineH
  }

  /** Draw a row of 1–3 cells with the given flex fractions, plus rules. The row
   *  grows to fit the tallest wrapped value. */
  private drawCellRow(cells: (FieldCell & { frac: number })[]) {
    const widths = this.cellRowWidths(cells)
    const h = this.cellRowHeight(cells)
    const fy = this.y - h
    let cx = this.M
    cells.forEach((c, i) => {
      this.drawFieldCell(cx, fy, widths[i], h, c.label, c.value, c.status)
      if (i > 0) {
        this.page.drawLine({
          start: { x: cx, y: fy }, end: { x: cx, y: fy + h },
          thickness: 0.5, color: PDF.color.rule,
        })
      }
      cx += widths[i]
    })
    this.page.drawLine({
      start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy },
      thickness: 0.5, color: PDF.color.rule,
    })
    this.y -= h
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
    this.ensureSpace(rows.reduce((sum, r) => sum + this.cellRowHeight(r), 0))
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
  /** Render rows as a bordered form block. Each row is either an array of 1–3
   *  key-value cells (columns split the width evenly), or a checkbox row. */
  fieldGrid(rows: PDFGridRow[]) {
    if (rows.length === 0) return
    const totalH = rows.reduce((sum, row) =>
      sum + (Array.isArray(row) ? this.cellRowHeight(row.map(c => ({ ...c, frac: 1 }))) : this.rowH), 0)
    this.ensureSpace(totalH)
    const topY = this.y
    for (const row of rows) {
      if (Array.isArray(row)) {
        this.drawCellRow(row.map(c => ({ ...c, frac: 1 })))
      } else {
        this.drawCheckboxRow(row.checkboxes)
      }
    }
    this.blockBorder(topY)
    this.spacer(6)
  }

  /** Draw a full-width row of evenly-spaced checkboxes. */
  private drawCheckboxRow(items: PDFCheckbox[]) {
    const fy = this.y - this.rowH
    this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: this.rowH, color: PDF.color.white })
    const slotW = this.CW / items.length
    items.forEach((item, i) => {
      const bx = this.M + i * slotW + 8
      const by = fy + (this.rowH - 10) / 2
      this.page.drawRectangle({
        x: bx, y: by, width: 10, height: 10,
        color: PDF.color.white, borderColor: PDF.color.label, borderWidth: 1,
      })
      if (item.checked) {
        this.page.drawText("X", { x: bx + 1.8, y: by + 1.6, size: 9, font: this.bold, color: PDF.color.accent })
      }
      this.page.drawText(clip(this.bold, item.label, slotW - 30, PDF.size.label), {
        x: bx + 16, y: fy + 7, size: PDF.size.label, font: this.bold, color: PDF.color.label,
      })
    })
    this.page.drawLine({
      start: { x: this.M, y: fy }, end: { x: this.M + this.CW, y: fy },
      thickness: 0.5, color: PDF.color.rule,
    })
    this.y -= this.rowH
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
    return this.wrapTextWith(this.reg, text, size, maxW)
  }

  private wrapTextWith(font: PDFFont, text: string, size: number, maxW: number): string[] {
    const lines: string[] = []
    for (const paragraph of text.split(/\r?\n/)) {
      const words = paragraph.split(/\s+/).filter(Boolean)
      let cur = ""
      for (let word of words) {
        // Hard-break a single token longer than the column (emails, long file
        // names with no spaces) so it wraps by character instead of overflowing.
        while (font.widthOfTextAtSize(word, size) > maxW) {
          let fit = 1
          while (fit < word.length && font.widthOfTextAtSize(word.slice(0, fit + 1), size) <= maxW) fit++
          if (cur) { lines.push(cur); cur = "" }
          lines.push(word.slice(0, fit))
          word = word.slice(fit)
        }
        const next = cur ? `${cur} ${word}` : word
        if (font.widthOfTextAtSize(next, size) <= maxW) {
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

  // ── Plain paragraph + inline image (letter-style content, e.g. PCO cover) ─────
  /** A word-wrapped paragraph with no divider/title. Honors \n and alignment. */
  paragraph(body?: string | null, opts: { size?: number; bold?: boolean; gap?: number; muted?: boolean; align?: "left" | "right" } = {}) {
    if (!body || !body.trim()) return
    const size = opts.size ?? PDF.size.body
    const font = opts.bold ? this.bold : this.reg
    const color = opts.muted ? PDF.color.muted : PDF.color.ink
    const lineH = size + 5
    for (const line of this.wrapTextWith(font, body.trim(), size, this.CW)) {
      this.ensureSpace(lineH)
      const x = opts.align === "right" ? this.M + this.CW - font.widthOfTextAtSize(line, size) : this.M
      this.page.drawText(line, { x, y: this.y - (size + 1), size, font, color })
      this.y -= lineH
    }
    this.spacer(opts.gap ?? 4)
  }

  /** Draw an embedded image (PNG/JPG) at the cursor, scaled to fit maxW×maxH.
   *  Advances the cursor. Returns false if the bytes can't be decoded. */
  async image(bytes: ArrayBuffer | Uint8Array, opts: { maxW?: number; maxH?: number; align?: "left" | "center" | "right" } = {}): Promise<boolean> {
    const img = await this.embedImage(bytes)
    if (!img) return false
    const maxW = opts.maxW ?? this.CW
    const maxH = opts.maxH ?? 60
    const scale = Math.min(maxW / img.width, maxH / img.height, 1)
    const dw = img.width * scale, dh = img.height * scale
    this.ensureSpace(dh + 4)
    let x = this.M
    if (opts.align === "center") x = this.M + (this.CW - dw) / 2
    else if (opts.align === "right") x = this.M + this.CW - dw
    this.page.drawImage(img, { x, y: this.y - dh, width: dw, height: dh })
    this.y -= dh + 4
    return true
  }

  // ── Letterhead — custom header for letter-style docs (e.g. PCO cover) ─────────
  /** Logo left, company name centered, phone right, thick rule beneath. */
  async letterhead(opts: { logoBytes?: ArrayBuffer | null; companyName?: string | null; phone?: string | null }) {
    const top = this.H - PDF.topMargin
    let logoBottom = top - 12
    if (opts.logoBytes) {
      const img = await this.embedImage(opts.logoBytes)
      if (img) {
        const scale = Math.min(46 / img.height, 150 / img.width, 1)
        const dw = img.width * scale, dh = img.height * scale
        this.page.drawImage(img, { x: this.M, y: top - dh, width: dw, height: dh })
        logoBottom = top - dh
      }
    }
    if (opts.companyName) {
      const w = this.bold.widthOfTextAtSize(opts.companyName, 13)
      this.page.drawText(opts.companyName, { x: this.M + (this.CW - w) / 2, y: top - 22, size: 13, font: this.bold, color: PDF.color.ink })
    }
    if (opts.phone) {
      const w = this.reg.widthOfTextAtSize(opts.phone, 8.5)
      this.page.drawText(opts.phone, { x: this.M + this.CW - w, y: top - 9, size: 8.5, font: this.reg, color: PDF.color.label })
    }
    const ruleY = Math.min(logoBottom, top - 34) - 6
    this.page.drawLine({ start: { x: this.M, y: ruleY }, end: { x: this.M + this.CW, y: ruleY }, thickness: 1.5, color: PDF.color.ink })
    this.y = ruleY - 16
  }

  /** Bold uppercase label + value (value wraps and may span lines). */
  letterField(label: string, value?: string | null, opts: { labelW?: number; gap?: number } = {}) {
    const labelW = opts.labelW ?? 96
    const lines = value && value.trim() ? this.wrapTextWith(this.reg, value.trim(), PDF.size.value, this.CW - labelW) : ["—"]
    const lineH = PDF.size.value + 5
    this.ensureSpace(lines.length * lineH)
    this.page.drawText(label.toUpperCase(), { x: this.M, y: this.y - (PDF.size.value + 1), size: PDF.size.label, font: this.bold, color: PDF.color.label })
    let ly = this.y
    for (const line of lines) {
      this.page.drawText(line, { x: this.M + labelW, y: ly - (PDF.size.value + 1), size: PDF.size.value, font: this.reg, color: PDF.color.ink })
      ly -= lineH
    }
    this.y = ly
    this.spacer(opts.gap ?? 6)
  }

  // ── Grid table — full cell borders, per-column alignment, row highlight ───────
  private drawGridRow(values: string[], colW: number[], o: { header?: boolean; bold?: boolean; fill?: ReturnType<typeof rgb> | null; align?: ("left" | "right")[] }) {
    const h = o.header ? 20 : 18
    if (this.y - h < this.bottomLimit) this.pageBreak()
    const fy = this.y - h
    const fill = o.header ? PDF.color.fieldFill : o.fill
    if (fill) this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: h, color: fill })
    const font = o.header || o.bold ? this.bold : this.reg
    const size = o.header ? 7.5 : 8.5
    const color = o.header ? PDF.color.ruleStrong : PDF.color.ink
    let cx = this.M
    values.forEach((v, i) => {
      const raw = o.header ? (v ?? "").toUpperCase() : (v ?? "")
      const disp = clip(font, raw, colW[i] - 12, size)
      const right = o.align?.[i] === "right"
      const dw = font.widthOfTextAtSize(disp, size)
      this.page.drawText(disp, { x: right ? cx + colW[i] - 6 - dw : cx + 6, y: fy + (h - size) / 2, size, font, color })
      if (i > 0) this.page.drawLine({ start: { x: cx, y: fy }, end: { x: cx, y: fy + h }, thickness: 0.5, color: PDF.color.rule })
      cx += colW[i]
    })
    const border: [number, number, number, number][] = [
      [this.M, fy, this.M + this.CW, fy], [this.M, fy + h, this.M + this.CW, fy + h],
      [this.M, fy, this.M, fy + h], [this.M + this.CW, fy, this.M + this.CW, fy + h],
    ]
    for (const [x1, y1, x2, y2] of border) {
      this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: PDF.color.rule })
    }
    this.y -= h
  }

  /** A fully-bordered table. `align` sets per-column text alignment; `highlight`
   *  fills + bolds matching rows (yellow subtotal/total rows). Pass [] headers to
   *  skip the header row. */
  gridTable(headers: string[], rows: string[][], colW: number[], opts: { align?: ("left" | "right")[]; highlight?: (r: string[]) => boolean } = {}) {
    if (headers.length) this.drawGridRow(headers, colW, { header: true, align: opts.align })
    for (const r of rows) {
      const hl = opts.highlight?.(r) ?? false
      this.drawGridRow(r, colW, { align: opts.align, fill: hl ? PDF.color.highlight : null, bold: hl })
    }
    this.spacer(6)
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

  /** Draw one table data row. Cell values wrap across lines and the row grows to
   *  fit its tallest cell (so long descriptions are never clipped). Repeats the
   *  header automatically on a new page. */
  tableRow(values: string[], colWidths: number[], highlight = false) {
    const font = highlight ? this.bold : this.reg
    const lineH = 11
    const wrapped = values.map((v, i) => this.wrapTextWith(font, v && v !== "" ? v : "—", 8, colWidths[i] - 12))
    const maxLines = Math.max(1, ...wrapped.map(w => w.length))
    const h = 20 + (maxLines - 1) * lineH
    if (this.y - h < this.bottomLimit) {
      this.pageBreak()
      this.drawTableHeaderRow()
    }
    const fy = this.y - h
    if (highlight) {
      this.page.drawRectangle({ x: this.M, y: fy, width: this.CW, height: h, color: PDF.color.fieldFill })
    }
    let cx = this.M
    wrapped.forEach((lines, i) => {
      let ly = fy + h - 13   // first line sits at fy + 7 when h === 20
      for (const line of lines) {
        this.page.drawText(line, { x: cx + 7, y: ly, size: 8, font, color: PDF.color.ink })
        ly -= lineH
      }
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

  // ── Log table — wide, spreadsheet-style list (Submittal / Change-Order logs) ──
  /** Render a column-defined table where every cell WRAPS — long descriptions,
   *  file names and vendor names never clip (long unspaced tokens hard-break via
   *  the shared wrap). Rows auto-grow to their tallest cell, the column header
   *  repeats after every page break, per-column alignment is honored, and full
   *  cell borders give it a log look. `cols` widths should sum to ~this.CW; pass
   *  `highlight` to bold + tint summary rows (e.g. totals). */
  logTable(
    cols: { header: string; width: number; align?: "left" | "right" }[],
    rows: string[][],
    opts: { highlight?: (r: string[]) => boolean } = {},
  ) {
    const PADX = 5, PADY = 4
    const headerSize = 7, bodySize = 7.5, lineH = bodySize + 2.5
    const totalW = cols.reduce((s, c) => s + c.width, 0)

    const vline = (x: number, fy: number, h: number) =>
      this.page.drawLine({ start: { x, y: fy }, end: { x, y: fy + h }, thickness: 0.5, color: PDF.color.rule })
    const box = (fy: number, h: number) => {
      const edges: [number, number, number, number][] = [
        [this.M, fy, this.M + totalW, fy], [this.M, fy + h, this.M + totalW, fy + h],
        [this.M, fy, this.M, fy + h], [this.M + totalW, fy, this.M + totalW, fy + h],
      ]
      for (const [x1, y1, x2, y2] of edges) this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: PDF.color.rule })
    }

    const drawHeaderRow = () => {
      const h = 18
      const fy = this.y - h
      this.page.drawRectangle({ x: this.M, y: fy, width: totalW, height: h, color: PDF.color.fieldFill })
      let cx = this.M
      cols.forEach((c, i) => {
        const t = clip(this.bold, c.header.toUpperCase(), c.width - PADX * 2, headerSize)
        const tw = this.bold.widthOfTextAtSize(t, headerSize)
        const tx = c.align === "right" ? cx + c.width - PADX - tw : cx + PADX
        this.page.drawText(t, { x: tx, y: fy + (h - headerSize) / 2 + 0.5, size: headerSize, font: this.bold, color: PDF.color.ruleStrong })
        if (i > 0) vline(cx, fy, h)
        cx += c.width
      })
      box(fy, h)
      this.y -= h
    }

    this.ensureSpace(18 + 30)   // keep the header off the very bottom of a page
    drawHeaderRow()
    for (const r of rows) {
      const hl = opts.highlight?.(r) ?? false
      const font = hl ? this.bold : this.reg
      const wrapped = cols.map((c, i) => this.wrapTextWith(font, r[i] ?? "", bodySize, c.width - PADX * 2))
      const maxLines = Math.max(1, ...wrapped.map(w => w.length))
      const h = PADY * 2 + maxLines * lineH
      if (this.y - h < this.bottomLimit) { this.pageBreak(); drawHeaderRow() }
      const fy = this.y - h
      if (hl) this.page.drawRectangle({ x: this.M, y: fy, width: totalW, height: h, color: PDF.color.fieldFill })
      let cx = this.M
      cols.forEach((c, i) => {
        let ly = fy + h - PADY - bodySize
        for (const line of wrapped[i]) {
          const lw = font.widthOfTextAtSize(line, bodySize)
          const tx = c.align === "right" ? cx + c.width - PADX - lw : cx + PADX
          this.page.drawText(line, { x: tx, y: ly, size: bodySize, font, color: PDF.color.ink })
          ly -= lineH
        }
        if (i > 0) vline(cx, fy, h)
        cx += c.width
      })
      box(fy, h)
      this.y -= h
    }
    this.spacer(6)
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

  // ── PDFStampGrid ─────────────────────────────────────────────────────────────
  /** Draw a 2×2 grid of review-stamp boxes filling the space down to the footer.
   *  Each box shows its stamp content, or a "<role> Stamp" placeholder. When a
   *  `reviewer` is supplied, OUR review stamp is rendered into the top-left box
   *  (index 0) — the box GCs reserve for their own stamp. */
  stampGrid(stamps?: PDFStamp[], reviewer?: PDFReviewerStamp | null) {
    const resolved: PDFStamp[] = (stamps ?? [
      { role: "GC" }, { role: "Architect" }, { role: "Engineer" }, { role: "Subcontractor" },
    ]).slice(0, 4)
    this.spacer(10)
    const gap = 13
    const cellW = (this.CW - gap) / 2
    const top = this.y
    const cellH = (top - this.bottomLimit - gap) / 2
    resolved.forEach((stamp, i) => {
      const sx = this.M + (i % 2) * (cellW + gap)
      const sy = top - Math.floor(i / 2) * (cellH + gap) - cellH
      this.page.drawRectangle({
        x: sx, y: sy, width: cellW, height: cellH,
        color: PDF.color.white, borderColor: PDF.color.ruleStrong, borderWidth: 0.75,
      })
      if (i === 0 && reviewer) {
        this.drawReviewerStamp(sx, sy, cellW, cellH, reviewer)
      } else if (stamp.content && stamp.content.trim()) {
        this.page.drawText(clip(this.reg, stamp.content, cellW - 16, 8.5), {
          x: sx + 8, y: sy + cellH - 20, size: 8.5, font: this.reg, color: PDF.color.ink,
        })
      } else {
        const placeholder = `${stamp.role} Stamp`
        const pw = this.reg.widthOfTextAtSize(placeholder, 8)
        this.page.drawText(placeholder, {
          x: sx + cellW - pw - 8, y: sy + 8, size: 8, font: this.reg, color: PDF.color.muted,
        })
      }
    })
    this.y = top - 2 * cellH - gap
  }

  /** Render OUR review stamp inside a stamp-grid box at (x,y,w,h). A red header
   *  bar (title + company), label rows, a full-width "REVIEWED" divider, then
   *  the small-print review language. Everything is sized against the box height
   *  so it scales down rather than spilling past the border. */
  private drawReviewerStamp(x: number, y: number, w: number, h: number, s: PDFReviewerStamp) {
    const red = rgb(0.70, 0.12, 0.12)
    const pad = 7
    const innerX = x + pad
    const innerW = w - pad * 2

    // Design targets ~190pt of box height; shrink uniformly when the box is
    // shorter so the header/rows/divider never overrun the cell.
    const scale = Math.min(1, h / 190)
    const headerH   = 17 * scale
    const rowH      = 13.5 * scale
    const dividerH  = 12 * scale
    const headerSz  = 8.5 * scale
    const labelSz   = 7 * scale
    const valueSz   = 8 * scale

    let cy = y + h // top edge — draw downward

    // ── Header bar: "Submittal Stamp" left, company right ──────────────────────
    cy -= headerH
    this.page.drawRectangle({ x, y: cy, width: w, height: headerH, color: red })
    this.page.drawText("Submittal Stamp", {
      x: innerX, y: cy + (headerH - headerSz) / 2 + 0.5, size: headerSz, font: this.bold, color: PDF.color.white,
    })
    if (s.company) {
      const co = clip(this.bold, s.company.toUpperCase(), innerW * 0.55, labelSz)
      const cow = this.bold.widthOfTextAtSize(co, labelSz)
      this.page.drawText(co, {
        x: x + w - pad - cow, y: cy + (headerH - labelSz) / 2 + 0.5, size: labelSz, font: this.bold, color: PDF.color.white,
      })
    }

    // ── Label rows ─────────────────────────────────────────────────────────────
    const row = (label: string, value: string) => {
      cy -= rowH
      this.page.drawText(label, {
        x: innerX, y: cy + (rowH - labelSz) / 2 + 0.5, size: labelSz, font: this.bold, color: PDF.color.label,
      })
      const lw = this.bold.widthOfTextAtSize(label, labelSz)
      this.page.drawText(clip(this.reg, value && value.trim() ? value : "—", innerW - lw - 5, valueSz), {
        x: innerX + lw + 5, y: cy + (rowH - valueSz) / 2 + 0.5, size: valueSz, font: this.reg, color: PDF.color.ink,
      })
    }

    row("Project: ", s.projectName)
    row("Project #: ", s.projectNumber)

    // ── Full-width "REVIEWED" divider ──────────────────────────────────────────
    cy -= dividerH
    this.page.drawRectangle({ x, y: cy, width: w, height: dividerH, color: red })
    const dt = "REVIEWED"
    const dtw = this.bold.widthOfTextAtSize(dt, labelSz)
    this.page.drawText(dt, {
      x: x + (w - dtw) / 2, y: cy + (dividerH - labelSz) / 2 + 0.5, size: labelSz, font: this.bold, color: PDF.color.white,
    })

    if (s.submittalNo && s.submittalNo.trim()) row("Submittal No: ", s.submittalNo)
    row("Reviewed By: ", s.reviewedBy)
    row("Date: ", s.date)

    // ── Review-language small print — fills the remaining height, shrinking the
    //    font (then dropping trailing lines) before it can overflow the box. ─────
    const availH = cy - y - pad
    if (availH > 7 && s.reviewText.trim()) {
      let pSz = 6 * scale
      let lines = this.wrapTextWith(this.reg, s.reviewText, pSz, innerW)
      let pLineH = pSz + 1.5
      while (pSz > 4.5 && lines.length * pLineH > availH) {
        pSz -= 0.25
        lines = this.wrapTextWith(this.reg, s.reviewText, pSz, innerW)
        pLineH = pSz + 1.5
      }
      const maxLines = Math.max(0, Math.floor(availH / pLineH))
      let py = cy - 3 * scale
      for (const line of lines.slice(0, maxLines)) {
        py -= pLineH
        this.page.drawText(line, { x: innerX, y: py, size: pSz, font: this.reg, color: PDF.color.muted })
      }
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

}
