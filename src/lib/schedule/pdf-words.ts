// ── unpdf positional-text seam (server only) ─────────────────────────────────
// The schedule-import parser needs per-word x/y to derive column bands from the
// header row. unpdf's extractText() merges a page into one string and loses
// positions, so we go one level lower: getDocumentProxy() returns the pdf.js
// document, and page.getTextContent() yields text items with a transform matrix,
// an advance width, and a fontName (the only thing that separates Asta summary
// rows from leaf rows). This is the SAME unpdf/pdfjs already used by
// spec-parser.ts — no new dependency. Node runtime.
//
// We map every item through the page viewport (convertToViewportPoint) so the
// coordinates are in DISPLAYED orientation. That is a no-op for upright pages but
// is essential for /Rotate 90 exports (some P6 PDFs), where the raw text matrix
// would otherwise put the table on a sideways axis and break column detection.
// Display-space y grows downward, so we flip it back to "higher = top" to match
// the PDF convention the parser expects.

import { getDocumentProxy, getResolvedPDFJS } from "unpdf"
import type { PdfPageWords, PdfWord } from "./import-parse"

interface RawItem { str?: string; transform?: number[]; width?: number; fontName?: string }
interface Viewport { height: number; convertToViewportPoint(x: number, y: number): number[] }

/** Extract one positioned-word list per page (1-based by array index + 1). */
export async function extractPdfWords(buffer: Buffer): Promise<PdfPageWords[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const pages: PdfPageWords[] = []

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const viewport = page.getViewport({ scale: 1 }) as Viewport // includes the page's /Rotate
    const content = await page.getTextContent()
    const words: PdfWord[] = []
    for (const item of content.items as RawItem[]) {
      if (!item.str || !item.str.trim() || !item.transform) continue
      const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      words.push({
        x: Math.round(vx),
        y: Math.round(viewport.height - vy), // flip to "higher = top"
        w: Math.round(item.width ?? 0),
        str: item.str,
        font: item.fontName ?? "",
      })
    }
    pages.push(words)
  }
  return pages
}

// ── Bluebeam-calendar bar geometry (server only) ─────────────────────────────
// The hand-built month-calendar lookaheads draw each task as a COLORED bar in a
// day cell; the caption text is centered inside that bar, so a multi-day bar's
// text drifts away from the bar's START cell (the true date). Text positions
// alone therefore mis-date multi-day tasks — the calendar parser anchors each
// task to the LEFT edge of its bar. That means we must read the bar rectangles,
// which the text layer doesn't carry. We walk the page operator list, track the
// CTM, and capture every short/wide rectangle painted with a non-grey fill
// (THP's PM uses tiling-PATTERN fills; other sheets may use a solid colour — we
// accept both). Coordinates come out in the SAME convention as extractPdfWords
// (PDF user space, "higher = top") so words and bars share one coordinate frame.
// Upright pages only — month calendars carry no /Rotate.

/** A colored task bar: its horizontal span and visual top, page coordinates. */
export interface PdfBar { x0: number; x1: number; top: number; h: number }
export type PdfPageBars = PdfBar[]

/** Is an RGB fill a "colored" bar fill (not white, not a grey/black border)? */
function isColoredFill(arg: unknown): boolean {
  let r: number, g: number, b: number
  if (typeof arg === "string") {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(arg.trim())
    if (!m) return false
    r = parseInt(m[1], 16) / 255; g = parseInt(m[2], 16) / 255; b = parseInt(m[3], 16) / 255
  } else if (Array.isArray(arg) && arg.length >= 3) {
    const scale = arg.some((v) => v > 1) ? 1 / 255 : 1
    r = Number(arg[0]) * scale; g = Number(arg[1]) * scale; b = Number(arg[2]) * scale
  } else return false
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max > 0.9 && min > 0.9) return false // ~white
  if (max - min < 0.12) return false // ~grey/black (cell borders, text)
  return true
}

/** Extract colored task-bar rectangles, one list per page (index + 1 = page no). */
export async function extractPdfBars(buffer: Buffer): Promise<PdfPageBars[]> {
  const pdfjs = await getResolvedPDFJS()
  const OPS = pdfjs.OPS as Record<string, number>
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const pages: PdfPageBars[] = []

  // 2×3 affine helpers (pdf.js matrices: [a,b,c,d,e,f]).
  const mul = (a: number[], b: number[]) => [
    a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
  ]
  const apply = (m: number[], x: number, y: number) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]]

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const { fnArray, argsArray } = await page.getOperatorList()
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    let barFill = false // current fill paints a colored bar (pattern or saturated rgb)
    const bars: PdfBar[] = []
    const seen = new Set<string>()

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]
      const a = argsArray[i] as never[]
      if (fn === OPS.save) stack.push(ctm.slice())
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
      else if (fn === OPS.transform) ctm = mul(ctm, a as unknown as number[])
      else if (fn === OPS.setFillColorN) barFill = true // tiling pattern (THP's bars)
      else if (fn === OPS.setFillRGBColor) barFill = isColoredFill((a as unknown[])[0])
      else if (fn === OPS.setFillGray) barFill = false
      else if (fn === OPS.constructPath && barFill) {
        // arg[2] = [x0,y0,x1,y1] path-space bbox; the bar may self-paint (the
        // pattern path needs no separate fill op) so we capture at construct time.
        const bb = (a as unknown[])[2] as ArrayLike<number> | undefined
        if (bb && bb.length === 4) {
          const [ax, ay] = apply(ctm, bb[0], bb[1])
          const [bx, by] = apply(ctm, bb[2], bb[3])
          const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx)
          const yl = Math.min(ay, by), yh = Math.max(ay, by)
          const w = x1 - x0, h = yh - yl
          // Task bars are wide and short; this excludes thin rules and full-cell
          // background panels. (Grey fills are already filtered by isColoredFill.)
          if (w >= 60 && h >= 4 && h <= 160) {
            const bar = { x0: Math.round(x0), x1: Math.round(x1), top: Math.round(yh), h: Math.round(h) }
            const k = `${bar.x0}:${bar.x1}:${bar.top}`
            if (!seen.has(k)) { seen.add(k); bars.push(bar) }
          }
        }
      }
    }
    pages.push(bars)
  }
  return pages
}
