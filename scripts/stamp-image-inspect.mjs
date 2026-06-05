// Inspect Sub 147's first 4 pages structurally: text char count + image
// count + image sizes per page. Tells us which pages are image-dominated
// (likely scanned stamp sheets) vs text-dominated (form templates with
// no extractable content). Also dump pages 4-N to confirm structure.
// READ-ONLY.

import { createClient } from "@supabase/supabase-js"
import { extractText, getDocumentProxy } from "unpdf"
import { PDFDocument, PDFRawStream } from "pdf-lib"
import { readFileSync, writeFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}

const SAMPLES = [
  { id: "Sub 147 NSMF",            local: "scripts/sub147.pdf" },
]

for (const s of SAMPLES) {
  console.log("\n" + "═".repeat(80))
  console.log(s.id)
  console.log("═".repeat(80))
  const buffer = readFileSync(s.local)

  // Text per page
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  console.log("Total pages:", pages.length)

  // Image inspection per page via pdf-lib
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
  const docPages = doc.getPages()

  console.log("\n  Page | Char count | Has text | Images | Image total bytes")
  console.log("  -----+------------+----------+--------+------------------")
  for (let i = 0; i < Math.min(pages.length, 6); i++) {
    const pageText = pages[i] ?? ""
    const charCount = pageText.replace(/\s+/g, "").length
    const hasText = charCount > 50 ? "YES" : "no"

    // Look at page XObject dictionary for /Image
    const page = docPages[i]
    let images = 0
    let totalImageBytes = 0
    try {
      const resources = page.node.Resources()
      const xobjects = resources?.lookup(doc.context.obj("XObject")) ?? resources?.get(doc.context.obj("XObject"))
      // Iterate /XObject dict for Image subtype
      const xobjDict = page.node.Resources()?.lookup(doc.context.obj("XObject"))
      // Simpler: traverse all indirect objects whose Subtype = Image, but
      // that's whole-document. Per-page: iterate page node's keys.
      const pageDict = page.node
      const resDict = pageDict.Resources()
      if (resDict) {
        const xoRef = resDict.get(doc.context.obj("XObject"))
        const xoDict = xoRef ? doc.context.lookup(xoRef) : null
        if (xoDict && typeof xoDict.entries === "function") {
          for (const [, xoVal] of xoDict.entries()) {
            const xo = doc.context.lookup(xoVal)
            if (!xo) continue
            const subtype = xo.dict?.get?.(doc.context.obj("Subtype"))
            const subtypeStr = subtype?.toString?.()
            if (subtypeStr === "/Image") {
              images++
              if (xo instanceof PDFRawStream) {
                totalImageBytes += xo.contents?.length ?? 0
              }
            }
          }
        }
      }
    } catch (e) {
      console.log("    (image inspect error on page " + (i+1) + ":", e.message + ")")
    }

    const kbStr = totalImageBytes > 0 ? `${(totalImageBytes / 1024).toFixed(1)} KB` : ""
    console.log(`  ${String(i+1).padStart(4)} | ${String(charCount).padStart(10)} | ${hasText.padEnd(8)} | ${String(images).padStart(6)} | ${kbStr}`)
  }

  console.log("\n  PAGE 1 TEXT (first 800 chars):")
  console.log("  " + (pages[0] ?? "").slice(0, 800).split("\n").map(l => "  " + l).join("\n"))
  console.log("\n  PAGE 2 TEXT (first 800 chars):")
  console.log("  " + (pages[1] ?? "").slice(0, 800).split("\n").map(l => "  " + l).join("\n"))
  console.log("\n  PAGE 3 TEXT (first 800 chars):")
  console.log("  " + (pages[2] ?? "").slice(0, 800).split("\n").map(l => "  " + l).join("\n"))
  console.log("\n  PAGE 4 TEXT (first 800 chars):")
  console.log("  " + (pages[3] ?? "").slice(0, 800).split("\n").map(l => "  " + l).join("\n"))
}
