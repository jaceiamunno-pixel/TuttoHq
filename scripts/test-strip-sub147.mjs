// Test the strip logic on Sub 147 (and a couple others) — report:
//   - Original total page count
//   - Strip end page (the last page consumed)
//   - Stripped page count
//   - First 200 chars of stripped page 1 (should be PRODUCT content,
//     not Waters cover or transmittal form)
// READ-ONLY. No writes; no upload.

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

// Mirror of pdf-strip.ts logic, with no TS imports so this runs as .mjs.
const BLANK = 10
const STAMP_SCAN = 6

function parsePdfDate(raw) {
  if (!raw) return null
  const s = String(raw).replace(/^\(D:|^D:|\)$/g, "").replace(/['"]/g, "")
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
async function findStampPage(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
  const pages = doc.getPages()
  let best = null
  const limit = Math.min(pages.length, STAMP_SCAN)
  for (let p = 0; p < limit; p++) {
    const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
    if (!annotsRef) continue
    const annots = doc.context.lookup(annotsRef)
    if (!(annots instanceof PDFArray)) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i))
      if (!(annot instanceof PDFDict)) continue
      const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
      if (subtype !== "/Stamp") continue
      const parsed = parsePdfDate(annot.get(doc.context.obj("CreationDate"))?.toString?.())
      if (!parsed) continue
      if (!best || parsed < best.date) best = { date: parsed, page: p + 1 }
    }
  }
  return best
}
async function stripPlan(buffer) {
  const stamp = await findStampPage(buffer)
  if (!stamp) return null
  const pdfProxy = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdfProxy, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  const totalPages = pages.length
  let end = stamp.page
  while (end < totalPages) {
    const next = pages[end] ?? ""
    const cc = next.replace(/\s+/g, "").length
    if (cc >= BLANK) break
    end++
  }
  if (end >= totalPages) return null
  return { stripEndPage: end, stamp, totalPages, pages }
}

const SAMPLES = [
  { id: "Sub 147 NSMF",              path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/24c39197-c9ec-4f19-85bf-08853fd31807_0301-0509_Sub_No_147_NSMF.pdf" },
  { id: "Sub 079 Ceramic Tile",      path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/7b25eb00-e55e-4c54-b743-824559af8828_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
  { id: "Sub 234-R3",                path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/245852a2-adfd-4a0c-b011-387a1b3d12cb_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
  { id: "Sub 030-R1 Hardware",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2fe7d076-60f7-49c8-8675-b990759bdd07_0301-0509_Sub_No_030-R1_Frame_and_Door_Schedule.pdf" },
]

for (const s of SAMPLES) {
  console.log("\n" + "═".repeat(80))
  console.log(s.id)
  console.log("═".repeat(80))
  const { data: blob, error } = await a.storage.from("submittals").download(s.path)
  if (error) { console.log("download error:", error.message); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())

  const plan = await stripPlan(buffer)
  if (!plan) { console.log("No strip plan (no stamp found OR would empty doc). Original kept."); continue }

  console.log(`Original total pages:  ${plan.totalPages}`)
  console.log(`Stamp on page:         ${plan.stamp.page}  (date ${plan.stamp.date})`)
  console.log(`Strip-end-page:        ${plan.stripEndPage}  (pages 1..${plan.stripEndPage} would be removed)`)
  console.log(`Stripped pages remaining: ${plan.totalPages - plan.stripEndPage}  (would be displayed in Library)`)

  // Page texts: report what each stripped page was, and what the first content page is.
  console.log("\nFront-matter pages that WOULD be stripped:")
  for (let i = 0; i < plan.stripEndPage; i++) {
    const t = (plan.pages[i] ?? "").replace(/\s+/g, " ").trim().slice(0, 100)
    console.log(`  page ${i+1}  (${(plan.pages[i] ?? "").replace(/\s+/g, "").length} chars):  ${t}`)
  }
  console.log("\nFirst page that WOULD REMAIN in Library view:")
  const firstRemainIdx = plan.stripEndPage  // 0-indexed = page stripEndPage+1 (1-based)
  const remainText = (plan.pages[firstRemainIdx] ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  console.log(`  page ${firstRemainIdx + 1}:  ${remainText}`)

  // Also actually generate the stripped PDF to confirm it can build.
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const dst = await PDFDocument.create()
  const indices = []
  for (let p = plan.stripEndPage; p < plan.totalPages; p++) indices.push(p)
  const copied = await dst.copyPages(src, indices)
  for (const p of copied) dst.addPage(p)
  const out = await dst.save()
  console.log(`\nStripped PDF built OK. ${plan.totalPages - plan.stripEndPage} pages, ${(out.length / 1024).toFixed(0)} KB (original ${(buffer.length / 1024).toFixed(0)} KB)`)
}
