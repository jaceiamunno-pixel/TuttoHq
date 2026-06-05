// scripts/diagnose-strip-allfiles.mjs — READ-ONLY.
// Independent of the volatile submittals rows: pull every CURRENT attachment
// storage_path, download each real object, run the full strip pipeline, and
// report size / timing / peak memory / any exception. Finds whichever real
// files make stripFrontMatter throw or blow up.

import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await c.connect()

// Faithful replica of findStripPlan + stripFrontMatter, returns {ok, threw, ms, rssMB}
async function runStrip(buffer) {
  const t = Date.now()
  // findStripPlan
  let plan = null
  // stage 1: stamp scan (own try/catch in prod → returns null)
  let stamp = null
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
    const pages = doc.getPages()
    for (let p = 0; p < Math.min(pages.length, 6); p++) {
      const aref = pages[p].node.get(doc.context.obj("Annots"))
      if (!aref) continue
      const annots = doc.context.lookup(aref)
      if (!(annots instanceof PDFArray)) continue
      for (let i = 0; i < annots.size(); i++) {
        const a = doc.context.lookup(annots.get(i))
        if (!(a instanceof PDFDict)) continue
        if ((a.get(doc.context.obj("Subtype"))?.toString?.() ?? "") === "/Stamp") { stamp = stamp ?? { page: p + 1 }; }
      }
    }
  } catch { stamp = null }
  if (!stamp) return { ok: true, plan: null, ms: Date.now() - t, rssMB: (process.memoryUsage().rss / 1e6).toFixed(0), note: "no stamp → original" }

  // stage 2-5 are inside stripFrontMatter's try/catch in prod
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  await extractText(pdf, { mergePages: false })
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const dst = await PDFDocument.create()
  const copied = await dst.copyPages(src, src.getPageIndices().slice(1))
  for (const pg of copied) dst.addPage(pg)
  await dst.save()
  plan = { stamp: stamp.page }
  return { ok: true, plan, ms: Date.now() - t, rssMB: (process.memoryUsage().rss / 1e6).toFixed(0) }
}

const { rows } = await c.query(`
  SELECT DISTINCT storage_path FROM submittal_attachments WHERE storage_path IS NOT NULL
`)
console.log(`Current attachment objects: ${rows.length}\n`)

for (const { storage_path } of rows) {
  const { data: blob, error } = await sb.storage.from("submittals").download(storage_path)
  const name = storage_path.split("/").pop().slice(0, 50)
  if (error || !blob) { console.log(`✗ DOWNLOAD-FAIL  ${name}  (${error?.message}) → route returns explicit 500`); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const sizeMB = (buffer.length / 1e6).toFixed(2)
  try {
    const r = await runStrip(buffer)
    console.log(`✓ ${sizeMB}MB  ${r.ms}ms  rss=${r.rssMB}MB  ${r.plan ? "STRIPS" : "original"}  ${name}`)
  } catch (e) {
    console.log(`✗ STRIP-THREW  ${sizeMB}MB  ${e?.constructor?.name}: ${e?.message}  ${name}`)
  }
}
await c.end()
