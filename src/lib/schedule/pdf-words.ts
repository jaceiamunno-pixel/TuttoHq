// ── positional-text seam (server only) ───────────────────────────────────────
// The schedule-import parser needs per-word x/y to derive column bands from the
// header row. unpdf's extractText() merges a page into one string and loses
// positions, so we go one level lower: getDocumentProxy() returns the pdf.js
// document, and page.getTextContent() yields text items with a transform matrix,
// an advance width, and a fontName (the only thing that separates Asta summary
// rows from leaf rows). pdf.js stays the PRIMARY extractor — it is the same
// unpdf/pdfjs already used by spec-parser.ts and every file that parses today
// keeps the byte-identical path. Node runtime.
//
// We map every item through the page viewport (convertToViewportPoint) so the
// coordinates are in DISPLAYED orientation. That is a no-op for upright pages but
// is essential for /Rotate 90 exports (some P6 PDFs), where the raw text matrix
// would otherwise put the table on a sideways axis and break column detection.
// Display-space y grows downward, so we flip it back to "higher = top" to match
// the PDF convention the parser expects.
//
// FALLBACK (MuPDF): some GC exports keep their whole text layer inside an
// optional-content (/OC) form XObject — pdf.js (and pdfplumber/pypdf) return
// ZERO characters for those pages, so the parser sees an empty page and bails.
// MuPDF — the same engine PyMuPDF/fitz wraps, here as the pure-WASM `mupdf`
// package, no Python — reads it. We only invoke it on pages where pdf.js came up
// empty, and only swap when MuPDF actually recovered more text, so files that
// already parse never load the WASM and never change. MuPDF's default stext path
// skips the /OC-gated XObject too; building the stext from an explicit display
// list with showExtras (toDisplayList(true)) is what descends into it.

import { getDocumentProxy, getResolvedPDFJS } from "unpdf"
import type { PdfPageWords, PdfWord } from "./import-parse"

interface RawItem { str?: string; transform?: number[]; width?: number; fontName?: string }
interface Viewport { height: number; convertToViewportPoint(x: number, y: number): number[] }

// Below this many text-layer characters a page is treated as effectively empty
// and handed to the MuPDF fallback (the /OC-gated case returns ~0 from pdf.js).
const MIN_PAGE_CHARS = 16

const pageChars = (words: PdfPageWords) => words.reduce((n, w) => n + w.str.length, 0)

/** Extract one positioned-word list per page (1-based by array index + 1). pdf.js
 *  is primary; any page it returns empty for is retried through the MuPDF fallback. */
export async function extractPdfWords(buffer: Buffer): Promise<PdfPageWords[]> {
  const pages = await extractWordsViaPdfjs(buffer)

  const emptyPages = pages
    .map((words, i) => (pageChars(words) < MIN_PAGE_CHARS ? i : -1))
    .filter((i) => i >= 0)
  if (emptyPages.length === 0) return pages

  try {
    const mupdfPages = await extractWordsViaMupdf(buffer)
    for (const i of emptyPages) {
      // Only replace when MuPDF genuinely recovered more text — never regress a
      // page pdf.js already read (e.g. a sparse Gantt-only continuation page).
      if (mupdfPages[i] && pageChars(mupdfPages[i]) > pageChars(pages[i])) {
        pages[i] = mupdfPages[i]
      }
    }
  } catch (e) {
    // MuPDF is best-effort recovery; if the WASM can't load, keep pdf.js output.
    console.error("schedule-import: MuPDF fallback extraction failed:", e)
  }
  return pages
}

/** Primary extractor: pdf.js text items mapped to displayed orientation. */
async function extractWordsViaPdfjs(buffer: Buffer): Promise<PdfPageWords[]> {
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

// MuPDF structured-text JSON (the subset we read). asJSON() emits text blocks of
// lines; each line carries a font, its baseline origin (x/y), and a bbox.
interface MupdfLine { text?: string; x?: number; y?: number; bbox?: { x: number; y: number; w: number; h: number }; font?: { name?: string } }
interface MupdfBlock { type: string; lines?: MupdfLine[] }
interface MupdfStext { blocks: MupdfBlock[] }

/** Fallback extractor: MuPDF (WASM). Lazily imported so normal files never load
 *  the ~10 MB engine. Emits the SAME {x,y,w,str,font} shape the detector consumes,
 *  with y flipped to "higher = top" to match the pdf.js seam. */
async function extractWordsViaMupdf(buffer: Buffer): Promise<PdfPageWords[]> {
  const mupdf = await import("mupdf")
  const doc = mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf")
  const pages: PdfPageWords[] = []

  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i)
    const bounds = page.getBounds() // [x0, y0, x1, y1]; structured-text y grows DOWN
    const height = bounds[3] - bounds[1]
    // showExtras=true descends the /OC-gated form XObject the default path skips.
    const stext = page.toDisplayList(true).toStructuredText("preserve-whitespace")
    const json = JSON.parse(stext.asJSON()) as MupdfStext

    const words: PdfWord[] = []
    for (const block of json.blocks) {
      if (block.type !== "text" || !block.lines) continue
      for (const line of block.lines) {
        const str = line.text
        if (!str || !str.trim()) continue
        const x = line.bbox?.x ?? line.x ?? 0
        const baseY = line.y ?? line.bbox?.y ?? 0 // MuPDF gives a per-line baseline origin
        words.push({
          x: Math.round(x),
          y: Math.round(height - baseY), // flip to "higher = top"
          w: Math.round(line.bbox?.w ?? 0),
          str,
          font: line.font?.name ?? "",
        })
      }
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
