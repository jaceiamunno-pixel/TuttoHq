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

import { getDocumentProxy } from "unpdf"
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
