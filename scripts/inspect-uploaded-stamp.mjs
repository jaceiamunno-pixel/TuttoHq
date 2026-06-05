// scripts/inspect-uploaded-stamp.mjs — READ-ONLY.
// Find recent DIRECT Library uploads (source='manual'/'gmail') with a file,
// download each, and report whether the strip would find an anchor:
//   - PDF /Stamp annotation in first 6 pages → the ?stripped=1 wiring fix
//     WILL strip it.
//   - No /Stamp annotation → strip finds no anchor, shows original →
//     needs the broader image-stamp detection.
// Also reports per-page image XObject counts (a coversheet with images but
// no /Stamp hints at a flattened-image stamp).

import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await c.connect()

const { rows } = await c.query(`
  SELECT id, file_name, storage_path, source, mime_type, created_at
  FROM submittals
  WHERE source IN ('manual','gmail') AND storage_path IS NOT NULL AND status<>'deleted'
    AND mime_type = 'application/pdf'
  ORDER BY created_at DESC
  LIMIT 6
`)
console.log(`Recent direct (manual/gmail) PDF uploads: ${rows.length}\n`)

for (const r of rows) {
  console.log("═".repeat(74))
  console.log(`${r.source} · ${r.file_name}`)
  console.log(`  id=${r.id}  created=${r.created_at?.toISOString?.().slice(0,16)}`)
  console.log(`  path=${r.storage_path}`)
  const { data: blob, error } = await sb.storage.from("submittals").download(r.storage_path)
  if (error || !blob) { console.log(`  ✗ download failed: ${error?.message}`); continue }
  const buf = Buffer.from(await blob.arrayBuffer())
  let doc
  try { doc = await PDFDocument.load(buf, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }) }
  catch (e) { console.log(`  ✗ parse failed: ${e.message}`); continue }
  const pages = doc.getPages()
  let stampFound = false
  const SCAN = Math.min(6, pages.length)
  for (let p = 0; p < SCAN; p++) {
    let stamps = 0, widgets = 0, images = 0
    const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
    if (annotsRef) {
      const annots = doc.context.lookup(annotsRef)
      if (annots instanceof PDFArray) {
        for (let i = 0; i < annots.size(); i++) {
          const a = doc.context.lookup(annots.get(i))
          if (!(a instanceof PDFDict)) continue
          const sub = a.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
          if (sub === "/Stamp") stamps++
          else if (sub === "/Widget") widgets++
        }
      }
    }
    const res = pages[p].node.Resources?.()
    if (res) {
      const xoRef = res.get(doc.context.obj("XObject"))
      const xo = xoRef ? doc.context.lookup(xoRef) : null
      if (xo instanceof PDFDict) {
        for (const [, ref] of xo.entries()) {
          const obj = doc.context.lookup(ref)
          const st = (obj)?.dict?.get?.(doc.context.obj("Subtype"))
          if (st instanceof PDFName && st.toString() === "/Image") images++
        }
      }
    }
    if (stamps > 0) stampFound = true
    console.log(`  page ${p+1}: /Stamp=${stamps}  /Widget=${widgets}  images=${images}`)
  }
  console.log(`  → ${stampFound
    ? "PDF /Stamp annotation PRESENT → ?stripped=1 wiring fix WILL strip it."
    : "NO /Stamp annotation in first " + SCAN + " pages → strip finds no anchor, shows ORIGINAL. Needs broader image-stamp detection."}`)
}
await c.end()
