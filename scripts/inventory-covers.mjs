// scripts/inventory-covers.mjs — READ-ONLY.
// Categorize recent Library uploads into cover buckets:
//   A: form-anchor  — /Widget cover in first 5 pages (already strips)
//   B: stamp-anchor — /Stamp in first 6 pages (already strips)
//   C: FLAT cover   — no widget/stamp, but leading page(s) look like a
//                     transmittal/cover (logo image + transmittal text)
//   D: raw datasheet — no cover at all (should never strip)
// Reports per-file signals + page-1 snippet (to ID the GC/format) + bucket
// counts. Heuristic bucketing for C vs D; snippet lets us verify by eye.

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

// Generic transmittal / cover-letter signals (NOT generic "Approved"/"Shop
// Drawing" that appear in content — these are letter/transmittal-specific).
const TRANSMITTAL = /letter of transmittal|transmittal (form|no|sheet|cover)|we are (sending|transmitting|forwarding)|for your (approval|review|use|records)|submittal (cover|transmittal)|please find|enclosed (please|are|is)|attention:|we transmit|herewith|gentlemen|gilbane|shawmut|turner construction|suffolk|consigli|skanska|whiting-turner|submitted to|submitted by|date submitted/i

const { rows } = await c.query(`
  SELECT id, file_name, storage_path, stripped_storage_path, created_at, source, project_id
  FROM submittals
  WHERE status <> 'deleted' AND mime_type = 'application/pdf' AND storage_path IS NOT NULL
    AND created_at >= '2026-06-05T18:00:00Z'
  ORDER BY created_at
`)
console.log(`Recent PDF uploads (since 18:00Z): ${rows.length}\n`)

const buckets = { A: [], B: [], C: [], D: [], ERR: [] }

for (const r of rows) {
  const nm = String(r.file_name).slice(0, 44)
  let doc, buf
  try {
    const { data: blob, error } = await sb.storage.from("submittals").download(r.storage_path)
    if (error || !blob) { buckets.ERR.push(nm); console.log(`ERR download  ${nm}`); continue }
    buf = Buffer.from(await blob.arrayBuffer())
    doc = await PDFDocument.load(buf, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
  } catch (e) { buckets.ERR.push(nm); console.log(`ERR parse  ${nm}  ${e.message}`); continue }

  const pages = doc.getPages()
  let widget = 0, stamp = 0, p1img = 0
  for (let p = 0; p < Math.min(pages.length, 6); p++) {
    const aref = pages[p].node.get(doc.context.obj("Annots"))
    if (aref) {
      const an = doc.context.lookup(aref)
      if (an instanceof PDFArray) for (let i = 0; i < an.size(); i++) {
        const a = doc.context.lookup(an.get(i)); if (!(a instanceof PDFDict)) continue
        const s = a.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
        if (s === "/Widget" && p < 5) widget++
        else if (s === "/Stamp") stamp++
      }
    }
    if (p === 0) {
      const res = pages[p].node.Resources?.()
      if (res) { const xr = res.get(doc.context.obj("XObject")); const xo = xr ? doc.context.lookup(xr) : null
        if (xo instanceof PDFDict) for (const [, ref] of xo.entries()) { const o = doc.context.lookup(ref); const st = o?.dict?.get?.(doc.context.obj("Subtype")); if (st instanceof PDFName && st.toString() === "/Image") p1img++ } }
    }
  }

  // page-1/2 text only needed to split C vs D
  let p1 = "", p2 = ""
  if (widget === 0 && stamp === 0) {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      const { text } = await extractText(pdf, { mergePages: false })
      const pt = Array.isArray(text) ? text : [text]
      p1 = (pt[0] ?? ""); p2 = (pt[1] ?? "")
    } catch {}
  }

  let bucket
  if (widget > 0) bucket = "A"
  else if (stamp > 0) bucket = "B"
  else {
    const lead = (p1 + " " + p2)
    bucket = TRANSMITTAL.test(lead) ? "C" : "D"
  }
  buckets[bucket].push(nm)

  const stripFlag = r.stripped_storage_path ? "STRIPPED" : "null"
  const snip = p1.replace(/\s+/g, " ").trim().slice(0, 56)
  console.log(`[${bucket}] ${stripFlag.padEnd(8)} w=${widget} s=${stamp} p1img=${p1img}  ${nm}${bucket === "C" || bucket === "D" ? "  | p1: " + snip : ""}`)
}

console.log(`\n══ BUCKET COUNTS ══`)
console.log(`  A (form-anchor, strips):     ${buckets.A.length}`)
console.log(`  B (stamp-anchor, strips):    ${buckets.B.length}`)
console.log(`  C (FLAT cover — the gap):    ${buckets.C.length}`)
console.log(`  D (raw datasheet, no cover): ${buckets.D.length}`)
console.log(`  ERR:                         ${buckets.ERR.length}`)
console.log(`  total:                       ${rows.length}`)

console.log(`\n══ BUCKET C (flat covers) — formats to ID ══`)
for (const nm of buckets.C) console.log("  · " + nm)
console.log(`\n══ BUCKET D (raw datasheets — must never strip) ══`)
for (const nm of buckets.D) console.log("  · " + nm)

await c.end()
