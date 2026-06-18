// In-app drawing markup — FLATTEN + EXPORT (ADR-005 Phase 2, Part 2b).
//
// Composites the editor's CURRENT vector markup (the [0,1]-normalized model in
// ./drawing-markup) onto page 1 of the sheet's ORIGINAL PDF at full vector
// resolution and returns single-page PDF bytes for a throwaway download.
//
// WHY a pdf-lib vector overlay (not a raster of the web viewer): the editor's
// on-screen background is a 1800px raster derivative — crisp on screen, fuzzy
// when printed. Drawing the markup straight onto the real PDF page keeps BOTH
// the sheet AND the markup as vectors, so the export is as sharp as the source.
// This reuses the same pdf-lib machinery the strip-at-upload path
// (src/lib/pdf-strip.ts) already relies on — no new PDF dependency.
//
// SACRED ORIGINAL: this READS the original bytes and builds a FRESH output doc
// (copyPages → draw → save). It never mutates the source file, writes no DB row,
// advances no current_revision_id, and does NOT touch the markup-revisions
// (Part 2a) path. Pure, throwaway, side-effect-free.
//
// COORDINATES: markup is normalized to the DISPLAYED page (post-/Rotate, the
// orientation the editor rasters and the user draws over). pdf-lib draws in the
// UNROTATED page space (origin bottom-left), so `toPage` maps displayed-
// normalized → unrotated page points for every /Rotate quadrant; text is also
// counter-rotated so it still reads upright once a viewer applies /Rotate.

import { PDFDocument, StandardFonts, LineCapStyle, degrees, rgb, type PDFPage, type PDFFont } from "pdf-lib"
import type { Markup, MarkupDoc } from "./drawing-markup"

type Color = ReturnType<typeof rgb>

/** "#DC2626" → pdf-lib rgb(); falls back to markup red on anything malformed. */
function hexToRgb(hex: string): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim())
  if (!m) return rgb(0.862, 0.149, 0.149) // #DC2626, the default markup red
  const n = parseInt(m[1], 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Snap a page /Rotate to a quadrant (pdf-lib reports the raw degrees). */
function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  return (((Math.round((angle || 0) / 90) * 90) % 360) + 360) % 360 as 0 | 90 | 180 | 270
}

// StandardFonts.Helvetica is WinAnsi — drawText THROWS on a glyph it can't
// encode. A throwaway export must never blow up on a stray smart-quote/emoji, so
// map the common typographic chars to ASCII and drop anything still un-encodable.
const SMART: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "–": "-", "—": "-", "…": "...", "•": "-", " ": " ",
}
function sanitizeForHelvetica(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[‘’“”–—…• ]/g, c => SMART[c] ?? " ")
    .replace(/[^\x20-\xFF]/g, "") // outside Latin-1 → drop (WinAnsi can't encode)
}

/** Download filename: "A-101-markup.pdf"; "sheet-markup.pdf" when unnamed. */
export function markupExportFilename(sheetNumber?: string | null): string {
  const safe = (sheetNumber ?? "").trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return `${safe || "sheet"}-markup.pdf`
}

/**
 * Composite `input` markup onto page 1 of `originalPdf` and return the flattened
 * single-page PDF bytes. The source buffer is read only; a new document is built.
 */
export async function exportMarkedUpSheet(
  originalPdf: ArrayBuffer | Uint8Array,
  input: Markup[] | MarkupDoc,
): Promise<Uint8Array> {
  const markups = Array.isArray(input) ? input : input.markups

  const src = await PDFDocument.load(originalPdf, { ignoreEncryption: true })
  if (src.getPageCount() === 0) throw new Error("Source PDF has no pages")

  // Fresh output, page 1 only — guarantees a single-page download and leaves the
  // source document object untouched. copyPages preserves /Rotate + CropBox.
  const out = await PDFDocument.create()
  const [page] = await out.copyPages(src, [0])
  out.addPage(page)
  const font = await out.embedFont(StandardFonts.Helvetica)

  const cb = page.getCropBox()
  const cw = cb.width, ch = cb.height, ox = cb.x, oy = cb.y
  const rot = normalizeRotation(page.getRotation().angle)
  // Displayed page height — what the editor's "fraction of height" scalars
  // (strokeWidth/fontSize) are relative to; width/height swap when sideways.
  const dispH = rot === 90 || rot === 270 ? cw : ch

  // displayed-normalized (top-left origin) → unrotated pdf-lib point (bottom-left
  // origin). `pu`/`pv` are page pixels in the unrotated crop box (top-left).
  const toPage = (nx: number, ny: number): { x: number; y: number } => {
    let pu: number, pv: number
    switch (rot) {
      case 90:  pu = ny * cw;       pv = (1 - nx) * ch; break
      case 180: pu = (1 - nx) * cw; pv = (1 - ny) * ch; break
      case 270: pu = (1 - ny) * cw; pv = nx * ch;       break
      default:  pu = nx * cw;       pv = ny * ch
    }
    return { x: ox + pu, y: oy + (ch - pv) }
  }

  for (const m of [...markups].sort((a, b) => a.z - b.z)) {
    drawMarkup(page, font, m, toPage, dispH, rot)
  }

  return out.save()
}

function drawMarkup(
  page: PDFPage,
  font: PDFFont,
  m: Markup,
  toPage: (nx: number, ny: number) => { x: number; y: number },
  dispH: number,
  rot: 0 | 90 | 180 | 270,
): void {
  const color = hexToRgb(m.style.color)
  const thickness = Math.max(0.5, m.style.strokeWidth * dispH)

  switch (m.type) {
    case "line": {
      // Freehand polyline → round-capped segments (joins read as continuous).
      for (let i = 1; i < m.points.length; i++) {
        page.drawLine({
          start: toPage(m.points[i - 1].x, m.points[i - 1].y),
          end: toPage(m.points[i].x, m.points[i].y),
          thickness, color, lineCap: LineCapStyle.Round,
        })
      }
      break
    }
    case "rect": {
      // 4 transformed corners as lines — stays correct under any /Rotate quadrant
      // (drawRectangle's axis-aligned w/h would need per-quadrant swizzling).
      const c = [
        toPage(m.x, m.y), toPage(m.x + m.w, m.y),
        toPage(m.x + m.w, m.y + m.h), toPage(m.x, m.y + m.h),
      ]
      for (let i = 0; i < 4; i++) {
        page.drawLine({ start: c[i], end: c[(i + 1) % 4], thickness, color, lineCap: LineCapStyle.Round })
      }
      break
    }
    case "arrow": {
      const a = toPage(m.x1, m.y1)
      const b = toPage(m.x2, m.y2)
      page.drawLine({ start: a, end: b, thickness, color, lineCap: LineCapStyle.Round })
      // Filled triangular head at b — angle derived in page space so it follows
      // any rotation automatically (mirrors the editor's SVG arrowhead).
      const ang = Math.atan2(b.y - a.y, b.x - a.x)
      const head = Math.max(thickness * 3.5, dispH * 0.012)
      const a1 = ang + Math.PI - 0.45, a2 = ang + Math.PI + 0.45
      const d1x = head * Math.cos(a1), d1y = head * Math.sin(a1)
      const d2x = head * Math.cos(a2), d2y = head * Math.sin(a2)
      // drawSvgPath puts path-(0,0) at {x,y} and flips SVG's y-down to page y-up,
      // so a page-space delta (dx,dy) is passed as (dx, -dy).
      page.drawSvgPath(`M 0 0 L ${d1x} ${-d1y} L ${d2x} ${-d2y} Z`, { x: b.x, y: b.y, color })
      break
    }
    case "text": {
      const size = Math.max(2, m.style.fontSize * dispH)
      // Editor anchors text at its top-left; the baseline sits ~fontSize below
      // (displayed space). Counter-rotate so it reads upright after /Rotate.
      const anchor = toPage(m.x, m.y + m.style.fontSize)
      page.drawText(sanitizeForHelvetica(m.text), {
        x: anchor.x, y: anchor.y, size, font, color, rotate: degrees(rot),
      })
      break
    }
  }
}
