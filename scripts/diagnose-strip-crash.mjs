// scripts/diagnose-strip-crash.mjs — READ-ONLY.
// Download the crashing submittal's PDF and run the strip pipeline stage by
// stage, reporting which stage throws / how long each takes / peak memory.
// Replicates findStripPlan() + stripFrontMatter() faithfully so we see what
// the production ?stripped=1 path actually hits.

import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await c.connect()

const ID = process.argv[2] ?? "50448d9d-1bd7-4bfb-a83a-29f10c8e3194"
const { rows: [row] } = await c.query(`SELECT file_name, storage_path, file_size FROM submittals WHERE id=$1`, [ID])
console.log(`File: ${row.file_name.slice(0, 60)}…`)
console.log(`Size: ${(row.file_size / 1e6).toFixed(2)} MB`)
console.log(`Path: ${row.storage_path}\n`)

const mb = () => (process.memoryUsage().rss / 1e6).toFixed(0)
async function stage(name, fn) {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`✓ ${name}  ${Date.now() - t}ms  rss=${mb()}MB`)
    return r
  } catch (e) {
    console.log(`✗ ${name}  THREW after ${Date.now() - t}ms: ${e?.constructor?.name}: ${e?.message}`)
    if (e?.stack) console.log(e.stack.split("\n").slice(0, 4).map(l => "    " + l).join("\n"))
    throw e
  }
}

const { data: blob, error } = await sb.storage.from("submittals").download(row.storage_path)
if (error) { console.log("download failed:", error.message); process.exit(1) }
const buffer = Buffer.from(await blob.arrayBuffer())
console.log(`Downloaded ${buffer.length} bytes  rss=${mb()}MB\n`)

// ── Replicate findStripPlan stage by stage ────────────────────────────
try {
  // Stage A: extractApprovalStampDate (pdf-lib annotation scan)
  const stamp = await stage("extractApprovalStampDate (pdf-lib load + annot scan)", async () => {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
    const pages = doc.getPages()
    let best = null
    for (let p = 0; p < Math.min(pages.length, 6); p++) {
      const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
      if (!annotsRef) continue
      const annots = doc.context.lookup(annotsRef)
      if (!(annots instanceof PDFArray)) continue
      for (let i = 0; i < annots.size(); i++) {
        const a = doc.context.lookup(annots.get(i))
        if (!(a instanceof PDFDict)) continue
        const sub = a.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
        if (sub === "/Stamp") { best = best ?? { page: p + 1 } }
      }
    }
    return best
  })
  console.log(`   stamp anchor: ${stamp ? "page " + stamp.page : "none"}`)
  if (!stamp) { console.log("\n→ No stamp; findStripPlan returns null → original served. (no crash here)") }

  // Stage B: unpdf getDocumentProxy + extractText (the heavy one)
  await stage("unpdf getDocumentProxy", async () => getDocumentProxy(new Uint8Array(buffer)))
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  await stage("unpdf extractText (per page)", async () => extractText(pdf, { mergePages: false }))

  // Stage C: PDFDocument.load WITHOUT throwOnInvalidObject (as findStripPlan does)
  await stage("PDFDocument.load { ignoreEncryption:true } (findStripPlan style)", async () =>
    PDFDocument.load(buffer, { ignoreEncryption: true }))

  // Stage D: collectPageMeta (XObject image scan)
  await stage("collectPageMeta (XObject/image scan)", async () => {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
    for (const page of doc.getPages()) {
      const res = page.node.Resources()
      if (!res) continue
      const xoRef = res.get(doc.context.obj("XObject"))
      const xo = xoRef ? doc.context.lookup(xoRef) : null
      if (xo instanceof PDFDict) {
        for (const [, ref] of xo.entries()) {
          const o = doc.context.lookup(ref)
          const st = o?.dict?.get?.(doc.context.obj("Subtype"))
          void (st instanceof PDFName && st.toString() === "/Image")
        }
      }
    }
  })

  // Stage E: copyPages + save (the actual strip output)
  await stage("copyPages + save (strip output)", async () => {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
    const dst = await PDFDocument.create()
    const idx = src.getPageIndices().slice(1) // drop page 1 as a stand-in
    const copied = await dst.copyPages(src, idx)
    for (const pg of copied) dst.addPage(pg)
    return (await dst.save()).length
  })

  console.log(`\n→ All stages completed locally. peak rss=${mb()}MB`)
} catch {
  console.log("\n→ A stage threw above. In production stripFrontMatter's try/catch SHOULD catch a thrown error and serve original — so a 500 implies either an UNCATCHABLE failure (OOM/timeout) OR the throw is outside the try/catch.")
} finally {
  await c.end()
}
