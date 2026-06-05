// Extract the Stamp annotation on page 2 of Sub 147 and inspect its
// appearance stream. A Stamp annotation has /AP (appearance dict) whose
// /N (normal appearance) is a Form XObject containing the stamp's
// drawing operators. We want to know:
//   - Does the appearance stream contain TEXT ops (Tj / TJ / ' / ") —
//     meaning the date and "Approved as Noted" are real text we can
//     parse with PDF.js or pdf-parse?
//   - Or is it pure path / image ops — meaning it's vector/raster art
//     that needs OCR or vector decoding?
//
// Also dump the annotation's /Contents (PDF spec optional alt-text) and
// any /T (annotation title) — these sometimes carry plaintext.
// READ-ONLY.

import { PDFDocument, PDFRawStream, PDFDict, PDFArray, PDFName, PDFString } from "pdf-lib"
import { readFileSync, writeFileSync } from "node:fs"
import { inflateSync } from "node:zlib"

const buffer = readFileSync("scripts/sub147.pdf")
const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
const pages = doc.getPages()
const page2 = pages[1]

console.log("Inspecting /Annots on page 2 of Sub 147 …\n")

const annotsRef = page2.node.get(doc.context.obj("Annots"))
const annots = doc.context.lookup(annotsRef)
console.log("Annot count:", annots instanceof PDFArray ? annots.size() : 0)

for (let i = 0; i < annots.size(); i++) {
  const annot = doc.context.lookup(annots.get(i))
  if (!(annot instanceof PDFDict)) continue
  const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? "?"
  console.log(`\n── Annot ${i} (Subtype=${subtype}) ──`)
  // Dump all keys
  console.log("  keys:", [...annot.entries()].map(([k]) => k.toString()).join(", "))
  // Common plaintext locations
  const t        = annot.get(doc.context.obj("T"))
  const contents = annot.get(doc.context.obj("Contents"))
  const name     = annot.get(doc.context.obj("Name"))
  const rect     = annot.get(doc.context.obj("Rect"))
  if (t)        console.log("  /T (annotation title):", t.toString())
  if (contents) console.log("  /Contents (alt text):  ", contents.toString())
  if (name)     console.log("  /Name (stamp name):    ", name.toString())
  if (rect)     console.log("  /Rect (position):      ", rect.toString())
  // Appearance stream — Form XObject under /AP /N
  const apRef = annot.get(doc.context.obj("AP"))
  if (apRef) {
    const ap = doc.context.lookup(apRef)
    if (ap instanceof PDFDict) {
      const nRef = ap.get(doc.context.obj("N"))
      const n = nRef ? doc.context.lookup(nRef) : null
      if (n instanceof PDFRawStream) {
        const raw = n.contents
        let stream = raw
        try {
          const dict = n.dict
          const filter = dict.get(doc.context.obj("Filter"))?.toString?.() ?? ""
          if (filter.includes("FlateDecode")) {
            stream = inflateSync(Buffer.from(raw))
          }
        } catch {}
        const head = stream.slice(0, Math.min(stream.length, 2000)).toString("latin1")
        console.log(`  Appearance /N stream length: ${stream.length} bytes`)
        // Count text-show ops in decoded stream
        const tjCount = (head.match(/\b(Tj|TJ|'|"")/g) || []).length
        const pathCount = (head.match(/\b(m|l|re|h|S|f|B)\b/g) || []).length
        console.log(`  Text ops (Tj/TJ): ${tjCount}   ·   Path ops: ${pathCount}`)
        console.log("  First 1500 chars of decoded content:")
        console.log(head.slice(0, 1500))

        writeFileSync("scripts/sub147-page2-stamp-appearance.bin", stream)
        console.log("  (Full decoded appearance saved to scripts/sub147-page2-stamp-appearance.bin)")
      } else {
        console.log("  /N is not a stream — type:", n?.constructor?.name)
      }
    }
  } else {
    console.log("  No /AP appearance dictionary")
  }
}
