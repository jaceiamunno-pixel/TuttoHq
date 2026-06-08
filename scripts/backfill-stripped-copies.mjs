// scripts/backfill-stripped-copies.mjs
//
// RECONCILE existing Library files to the UNIFIED leading-cover-run strip
// (mirror of src/lib/pdf-strip.ts). For each active PDF Library submittal in
// scope, recompute the plan and bring the stored stripped copy in line:
//   - plan strips  → (re)generate stripped copy, set stripped_storage_path
//                    (delete any prior stripped object first — handles files
//                     that got an OLD/short strip from strip-at-upload).
//   - plan no-strip→ if a stripped copy exists, delete it + null the column.
//
// Additive to ORIGINALS (never touched, never deleted). Idempotent: a file
// already matching the new plan is regenerated harmlessly (same pages).
//
// SCOPE: created_at >= SINCE (default the recent multi-GC batch). Pass a
// different ISO date as argv[2] to widen.

import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "") }
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await c.connect()

const SINCE = process.argv[2] ?? "2026-06-05T17:00:00Z"
const BLANK = 10, STAMP_TEXT_MAX = 600, MAX_COVER = 6
const COVER_VOCAB = new RegExp([
  "letter of transmittal","submittal transmittal","transmittal (?:form|sheet|cover|no\\.?|#)","we are (?:sending|transmitting|forwarding)",
  "submittal review stamp","for your (?:approval|review)\\b","reviewed (?:for|by)\\b","no exceptions taken","revise and resubmit","make corrections noted","(?:approved|rejected) as noted",
  "\\b(?:design and construction|building company|construction (?:company|managers?|group|co\\.|corp|llc|inc)|builders|general contractor)\\b",
  "submittal cover\\s?sheet","submittal\\s*(?:no\\.?|number|name)\\s*[:#]",
  "response to this submittal","change in contract",
].join("|"), "i")

async function planAndStrip(buf) {
  // returns { out: Buffer|null }  (null = no-strip)
  let doc
  try { doc = await PDFDocument.load(buf, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }) }
  catch { return { out: null } }
  const pages = doc.getPages()
  let pt = []
  try { const pdf = await getDocumentProxy(new Uint8Array(buf)); const { text } = await extractText(pdf, { mergePages: false }); pt = Array.isArray(text) ? text : [text] }
  catch { return { out: null } }
  const total = pages.length
  const meta = []
  for (let p = 0; p < total; p++) {
    let fw = 0, sa = 0, img = 0
    const aref = pages[p].node.get(doc.context.obj("Annots"))
    if (aref) { const an = doc.context.lookup(aref); if (an instanceof PDFArray) for (let i = 0; i < an.size(); i++) { const a = doc.context.lookup(an.get(i)); if (!(a instanceof PDFDict)) continue; const s = a.get(doc.context.obj("Subtype"))?.toString?.() ?? ""; if (s === "/Widget") fw++; else if (s === "/Stamp") sa++ } }
    const res = pages[p].node.Resources?.()
    if (res) { const xr = res.get(doc.context.obj("XObject")); const xo = xr ? doc.context.lookup(xr) : null; if (xo instanceof PDFDict) for (const [, ref] of xo.entries()) { const o = doc.context.lookup(ref); const st = o?.dict?.get?.(doc.context.obj("Subtype")); if (st instanceof PDFName && st.toString() === "/Image") img++ } }
    meta.push({ fw, sa, img, cc: (pt[p] ?? "").replace(/\s+/g, "").length })
  }
  const isCover = (i) => { const m = meta[i]; if (m.fw > 0) return true; if (m.cc < BLANK && m.img === 0) return true; if (m.sa > 0 && m.cc < STAMP_TEXT_MAX) return true; return COVER_VOCAB.test(pt[i] ?? "") }
  if (!isCover(0)) return { out: null }
  let last = 0
  while (last + 1 < total && last + 1 < MAX_COVER && isCover(last + 1)) last++
  const stripEnd = last + 1
  if (total - stripEnd < 1) return { out: null }
  try {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true })
    const dst = await PDFDocument.create()
    const idx = []; for (let p = stripEnd; p < total; p++) idx.push(p)   // keep pages after the cover run
    const copied = await dst.copyPages(src, idx)
    for (const pg of copied) dst.addPage(pg)
    return { out: Buffer.from(await dst.save()), plan: { stripStart: 1, stripEnd, total } }
  } catch { return { out: null } }
}

function safeBase(name) { const b = String(name).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80); return b || "submittal" }

const { rows } = await c.query(`
  SELECT id, company_id, storage_path, stripped_storage_path, left(file_name,42) nm
  FROM submittals
  WHERE status <> 'deleted' AND mime_type = 'application/pdf' AND storage_path IS NOT NULL
    AND created_at >= $1
  ORDER BY created_at
`, [SINCE])
console.log(`Reconcile scope: ${rows.length} active PDF Library files since ${SINCE}\n`)

let created = 0, regenerated = 0, cleared = 0, noanchor = 0, failed = 0
for (const r of rows) {
  let buf
  try { const { data: blob, error } = await sb.storage.from("submittals").download(r.storage_path); if (error || !blob) { failed++; console.log("✗ dl " + r.nm); continue } buf = Buffer.from(await blob.arrayBuffer()) }
  catch { failed++; continue }
  let res
  try { res = await planAndStrip(buf) } catch (e) { failed++; console.log("✗ plan " + r.nm + " " + e.message); continue }

  if (!res.out) {
    if (r.stripped_storage_path) {
      await sb.storage.from("submittals").remove([r.stripped_storage_path]).catch(() => {})
      await c.query(`UPDATE submittals SET stripped_storage_path = NULL WHERE id = $1`, [r.id])
      cleared++; console.log("· cleared (now no-strip)   " + r.nm)
    } else { noanchor++; console.log("· no-anchor (original)     " + r.nm) }
    continue
  }
  const newPath = `${r.company_id}/library-stripped/${crypto.randomUUID()}_${safeBase(r.nm)}.pdf`
  const up = await sb.storage.from("submittals").upload(newPath, res.out, { contentType: "application/pdf", upsert: false })
  if (up.error) { failed++; console.log("✗ upload " + r.nm + " " + up.error.message); continue }
  const upd = await c.query(`UPDATE submittals SET stripped_storage_path = $1 WHERE id = $2`, [newPath, r.id])
  if (upd.rowCount !== 1) { failed++; console.log("✗ update " + r.nm); continue }
  if (r.stripped_storage_path) { await sb.storage.from("submittals").remove([r.stripped_storage_path]).catch(() => {}); regenerated++; console.log(`✓ regenerated 1-${res.plan.stripEnd}/${res.plan.total}  ` + r.nm) }
  else { created++; console.log(`✓ created 1-${res.plan.stripEnd}/${res.plan.total}      ` + r.nm) }
}

console.log(`\n══ RESULT ══`)
console.log(`  created:     ${created}`)
console.log(`  regenerated: ${regenerated}  (replaced an old/short stripped copy)`)
console.log(`  cleared:     ${cleared}  (new logic = no-strip; old copy removed)`)
console.log(`  no-anchor:   ${noanchor}  (serve original)`)
console.log(`  failed:      ${failed}`)
console.log(`  total:       ${rows.length}`)
await c.end()
