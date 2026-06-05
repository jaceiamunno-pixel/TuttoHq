// Re-test the strip logic with the reworked heuristic. For each PDF:
//   - Report per-page meta (chars, widgets, stamp annots, image XObjects, "cover-shaped"?)
//   - Identify the contiguous cover run around the stamp anchor
//   - Show what would be stripped vs. kept
// READ-ONLY.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BLANK = 10
const STAMP_SCAN = 6
const COVER_KEYWORDS = /Submittal Transmittal Form|Submittal Disposition Stamp|Submittal Review Completed|Letter of Transmittal|Material Sample Transfer|Quality Control Program/i

function parsePdfDate(raw) {
  if (!raw) return null
  const s = String(raw).replace(/^\(D:|^D:|\)$/g, "").replace(/['"]/g, "")
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

async function inspect(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
  const pages = doc.getPages()
  const pdfProxy = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdfProxy, { mergePages: false })
  const pageTexts = Array.isArray(text) ? text : [text]

  // Per-page meta
  const meta = []
  let stamp = null
  for (let p = 0; p < pages.length; p++) {
    const t = pageTexts[p] ?? ""
    const charCount = t.replace(/\s+/g, "").length
    let formWidgetCount = 0, stampAnnotCount = 0, imageCount = 0
    const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
    if (annotsRef) {
      const annots = doc.context.lookup(annotsRef)
      if (annots instanceof PDFArray) {
        for (let i = 0; i < annots.size(); i++) {
          const annot = doc.context.lookup(annots.get(i))
          if (!(annot instanceof PDFDict)) continue
          const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
          if (subtype === "/Widget") formWidgetCount++
          else if (subtype === "/Stamp") {
            stampAnnotCount++
            if (p < STAMP_SCAN) {
              const parsed = parsePdfDate(annot.get(doc.context.obj("CreationDate"))?.toString?.())
              if (parsed && (!stamp || parsed < stamp.date)) stamp = { date: parsed, page: p + 1 }
            }
          }
        }
      }
    }
    const res = pages[p].node.Resources()
    if (res) {
      const xoRef = res.get(doc.context.obj("XObject"))
      const xoDict = xoRef ? doc.context.lookup(xoRef) : null
      if (xoDict instanceof PDFDict) {
        for (const [, ref] of xoDict.entries()) {
          const xo = doc.context.lookup(ref)
          const subtype = xo?.dict?.get?.(doc.context.obj("Subtype"))?.toString?.()
          if (subtype === "/Image") imageCount++
        }
      }
    }
    meta.push({ page: p + 1, charCount, formWidgetCount, stampAnnotCount, imageCount, text: t })
  }
  return { meta, stamp, totalPages: pages.length }
}

function isCoverShaped(m) {
  if (m.formWidgetCount > 0) return "widgets"
  if (m.stampAnnotCount > 0) return "stamp"
  if (m.charCount < BLANK && m.imageCount === 0) return "blank"
  if (m.imageCount === 0 && COVER_KEYWORDS.test(m.text)) return "keywords"
  return null
}

const SAMPLES = [
  { id: "Sub 147 NSMF",          path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/24c39197-c9ec-4f19-85bf-08853fd31807_0301-0509_Sub_No_147_NSMF.pdf" },
  { id: "Sub 079 Ceramic Tile",  path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/7b25eb00-e55e-4c54-b743-824559af8828_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
  { id: "Sub 234-R3",            path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/245852a2-adfd-4a0c-b011-387a1b3d12cb_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
  { id: "Sub 030-R1 Hardware",   path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2fe7d076-60f7-49c8-8675-b990759bdd07_0301-0509_Sub_No_030-R1_Frame_and_Door_Schedule.pdf" },
]

for (const s of SAMPLES) {
  console.log("\n" + "═".repeat(80))
  console.log(s.id)
  console.log("═".repeat(80))
  const { data: blob, error } = await a.storage.from("submittals").download(s.path)
  if (error) { console.log("download err:", error.message); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const { meta, stamp, totalPages } = await inspect(buffer)

  console.log("Per-page meta:")
  console.log("  page | chars | widgets | stamps | images | cover-shaped because")
  console.log("  -----+-------+---------+--------+--------+----------------------")
  for (const m of meta.slice(0, Math.min(meta.length, 8))) {
    const shape = isCoverShaped(m)
    console.log(`  ${String(m.page).padStart(4)} | ${String(m.charCount).padStart(5)} | ${String(m.formWidgetCount).padStart(7)} | ${String(m.stampAnnotCount).padStart(6)} | ${String(m.imageCount).padStart(6)} | ${shape ?? "(not cover-shaped — STOP)"}`)
  }
  if (meta.length > 8) console.log(`  …(${meta.length - 8} more pages)`)

  if (!stamp) { console.log("\nNo stamp found → strip nothing → original PDF served unchanged."); continue }

  // Walk both directions from stamp
  const stampIdx = stamp.page - 1
  let firstCover = stampIdx
  while (firstCover - 1 >= 0 && isCoverShaped(meta[firstCover - 1])) firstCover--
  let lastCover = stampIdx
  while (lastCover + 1 < totalPages && isCoverShaped(meta[lastCover + 1])) lastCover++

  const stripStart = firstCover + 1, stripEnd = lastCover + 1
  const remaining = totalPages - (stripEnd - stripStart + 1)

  console.log(`\nStamp anchor: page ${stamp.page} (date ${stamp.date})`)
  console.log(`Strip range: pages ${stripStart}..${stripEnd} (${stripEnd - stripStart + 1} pages removed)`)
  console.log(`Library view: ${remaining} pages remaining`)
  console.log(`Original PDF: ${totalPages} pages (unchanged on storage)`)

  // Show first page that REMAINS in Library view
  const firstKeptIdx = stripStart === 1 ? stripEnd : 0
  const firstKept = meta[firstKeptIdx]
  if (firstKept) {
    const sample = firstKept.text.replace(/\s+/g, " ").trim().slice(0, 150)
    console.log(`\nFirst Library page (${firstKept.page}): ${sample}`)
  }
}
