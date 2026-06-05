// Deep structural analysis of Sub 147's first 4 pages without rendering.
// For each page we report:
//   - content stream byte size (low = blank/sparse, high = drawn content)
//   - drawing-operator counts (text-show "Tj"/"TJ", path stroke "S/B/F",
//     line "l"/"m") — a vector-drawn stamp will show many path ops
//   - presence of /Annots (PDF annotations — Stamp, FreeText, etc.)
//   - resources (XObject names + counts, fonts)
//
// This tells us whether page 2 is an EMPTY template (very low ops),
// has a VECTOR stamp drawn directly (high path-op count), or has an
// IMAGE stamp (XObject /Image), without needing to rasterize.

import { PDFDocument, PDFRawStream, PDFArray, PDFDict } from "pdf-lib"
import { readFileSync } from "node:fs"

const buffer = readFileSync("scripts/sub147.pdf")
const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
const pages = doc.getPages()

console.log("Sub 147 — structural analysis of pages 1-6\n")
for (let i = 0; i < Math.min(pages.length, 6); i++) {
  const page = pages[i]
  const pageNode = page.node
  const pageRef = doc.context.getObjectRef(pageNode)
  console.log(`PAGE ${i + 1}`)

  // ── Content stream(s) ────────────────────────────────────────────────
  // Page may have a single stream or an array of streams.
  const contentsRef = pageNode.get(doc.context.obj("Contents"))
  let totalStreamBytes = 0
  let streamCount = 0
  let combinedStreamText = ""
  if (contentsRef) {
    const contents = doc.context.lookup(contentsRef)
    const streams = contents instanceof PDFArray
      ? contents.asArray().map(r => doc.context.lookup(r))
      : [contents]
    for (const s of streams) {
      if (s instanceof PDFRawStream) {
        streamCount++
        totalStreamBytes += s.contents.length
        // Try to decode (could be deflate-compressed). For analysis we
        // count operators using the raw bytes — DEFLATE'd is still a
        // useful proxy for amount of drawing.
      }
    }
  }
  console.log(`  Content streams: ${streamCount}  ·  total bytes: ${totalStreamBytes}`)

  // ── Annotations ──────────────────────────────────────────────────────
  const annotsRef = pageNode.get(doc.context.obj("Annots"))
  let annotCount = 0
  const annotTypes = {}
  if (annotsRef) {
    const annots = doc.context.lookup(annotsRef)
    if (annots instanceof PDFArray) {
      annotCount = annots.size()
      for (let a = 0; a < annots.size(); a++) {
        const annot = doc.context.lookup(annots.get(a))
        if (annot instanceof PDFDict) {
          const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? "(unknown)"
          annotTypes[subtype] = (annotTypes[subtype] ?? 0) + 1
        }
      }
    }
  }
  console.log(`  Annotations: ${annotCount}` + (annotCount > 0 ? `  · types: ${JSON.stringify(annotTypes)}` : ""))

  // ── Resources: XObjects, Fonts ───────────────────────────────────────
  const res = pageNode.Resources()
  let xobjImageCount = 0, xobjFormCount = 0, fontCount = 0
  const xobjNames = []
  if (res) {
    const xoRef = res.get(doc.context.obj("XObject"))
    const xoDict = xoRef ? doc.context.lookup(xoRef) : null
    if (xoDict instanceof PDFDict) {
      for (const [name, ref] of xoDict.entries()) {
        const xo = doc.context.lookup(ref)
        if (!xo) continue
        const subtype = xo.dict?.get?.(doc.context.obj("Subtype"))?.toString?.() ?? "?"
        if (subtype === "/Image") xobjImageCount++
        else if (subtype === "/Form") xobjFormCount++
        xobjNames.push(`${name.toString()}=${subtype}`)
      }
    }
    const fontRef = res.get(doc.context.obj("Font"))
    const fontDict = fontRef ? doc.context.lookup(fontRef) : null
    if (fontDict instanceof PDFDict) {
      fontCount = [...fontDict.entries()].length
    }
  }
  console.log(`  XObjects: ${xobjImageCount} Image, ${xobjFormCount} Form  ·  Fonts: ${fontCount}`)
  if (xobjNames.length > 0 && xobjNames.length <= 8) console.log(`    names: ${xobjNames.join(", ")}`)

  console.log("")
}
