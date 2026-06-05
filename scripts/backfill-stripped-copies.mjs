// scripts/backfill-stripped-copies.mjs
//
// One-time backfill for the strip-at-upload migration. For every active PDF
// submittal that has a file but no stripped copy yet, run the SAME strip the
// app's pdf-strip.ts performs, and if an anchor is found, upload the stripped
// copy + set submittals.stripped_storage_path.
//
// ADDITIVE ONLY: never deletes, never touches originals. Files with no
// cover/stamp anchor get no copy (stripped_storage_path stays null → view
// serves original). Idempotent: skips rows that already have a stripped copy.
//
// Logic mirrors src/lib/pdf-strip.ts (findStripPlan + stripFrontMatter):
//   anchor = first /Stamp annotation in pages 1..6; from it, walk BOTH
//   directions over contiguous "cover-shaped" pages; strip that closed
//   range; bail (serve original) if no anchor or strip would empty the doc.

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

const BLANK = 10
const STAMP_SCAN = 6
const COVER_KEYWORDS = /Submittal Transmittal Form|Submittal Disposition Stamp|Submittal Review Completed|Letter of Transmittal|Material Sample Transfer|Quality Control Program/i

function parsePdfDate(raw) {
  if (!raw) return null
  const s = String(raw).replace(/^\(D:|^D:|\)$/g, "").replace(/['"]/g, "")
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
function isCoverShaped(m, text) {
  if (m.formWidgetCount > 0) return true
  if (m.stampAnnotCount > 0) return true
  if (m.charCount < BLANK && m.imageCount === 0) return true
  if (m.imageCount === 0 && COVER_KEYWORDS.test(text)) return true
  return false
}

async function stripBuffer(buffer) {
  // returns { out: Buffer|null, plan } — null out = no strip (serve original)
  let doc
  try { doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }) }
  catch { return { out: null, plan: null } }
  const pages = doc.getPages()

  // stamp anchor
  let stamp = null
  for (let p = 0; p < Math.min(pages.length, STAMP_SCAN); p++) {
    const aref = pages[p].node.get(doc.context.obj("Annots"))
    if (!aref) continue
    const annots = doc.context.lookup(aref)
    if (!(annots instanceof PDFArray)) continue
    for (let i = 0; i < annots.size(); i++) {
      const a = doc.context.lookup(annots.get(i))
      if (!(a instanceof PDFDict)) continue
      if ((a.get(doc.context.obj("Subtype"))?.toString?.() ?? "") !== "/Stamp") continue
      const d = parsePdfDate(a.get(doc.context.obj("CreationDate"))?.toString?.())
      const info = { page: p + 1, date: d ?? "9999-99-99" }
      if (!stamp || info.date < stamp.date) stamp = info
    }
  }
  if (!stamp) return { out: null, plan: null }

  // per-page text + meta
  let pageTexts
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: false })
    pageTexts = Array.isArray(text) ? text : [text]
  } catch { return { out: null, plan: null } }
  const total = pages.length

  const meta = []
  for (let p = 0; p < total; p++) {
    let formWidgetCount = 0, stampAnnotCount = 0, imageCount = 0
    const aref = pages[p].node.get(doc.context.obj("Annots"))
    if (aref) {
      const annots = doc.context.lookup(aref)
      if (annots instanceof PDFArray) {
        for (let i = 0; i < annots.size(); i++) {
          const a = doc.context.lookup(annots.get(i))
          if (!(a instanceof PDFDict)) continue
          const sub = a.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
          if (sub === "/Widget") formWidgetCount++
          else if (sub === "/Stamp") stampAnnotCount++
        }
      }
    }
    const res = pages[p].node.Resources?.()
    if (res) {
      const xoRef = res.get(doc.context.obj("XObject"))
      const xo = xoRef ? doc.context.lookup(xoRef) : null
      if (xo instanceof PDFDict) {
        for (const [, ref] of xo.entries()) {
          const o = doc.context.lookup(ref)
          const st = o?.dict?.get?.(doc.context.obj("Subtype"))
          if (st instanceof PDFName && st.toString() === "/Image") imageCount++
        }
      }
    }
    meta.push({ formWidgetCount, stampAnnotCount, imageCount, charCount: (pageTexts[p] ?? "").replace(/\s+/g, "").length })
  }

  const stampIdx = stamp.page - 1
  let firstCover = stampIdx
  while (firstCover - 1 >= 0 && isCoverShaped(meta[firstCover - 1], pageTexts[firstCover - 1] ?? "")) firstCover--
  let lastCover = stampIdx
  while (lastCover + 1 < total && isCoverShaped(meta[lastCover + 1], pageTexts[lastCover + 1] ?? "")) lastCover++

  const stripStart = firstCover + 1, stripEnd = lastCover + 1
  const remaining = total - (stripEnd - stripStart + 1)
  if (remaining <= 0) return { out: null, plan: null }

  try {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
    const dst = await PDFDocument.create()
    const idx = []
    for (let p = 0; p < total; p++) { const ob = p + 1; if (ob >= stripStart && ob <= stripEnd) continue; idx.push(p) }
    const copied = await dst.copyPages(src, idx)
    for (const pg of copied) dst.addPage(pg)
    return { out: Buffer.from(await dst.save()), plan: { stripStart, stripEnd, total } }
  } catch { return { out: null, plan: null } }
}

function safeBase(name) {
  const b = String(name).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)
  return b || "submittal"
}

const { rows } = await c.query(`
  SELECT id, company_id, storage_path, file_name
  FROM submittals
  WHERE status <> 'deleted'
    AND storage_path IS NOT NULL
    AND mime_type = 'application/pdf'
    AND stripped_storage_path IS NULL
  ORDER BY created_at
`)
console.log(`Candidates (active PDF, has file, no stripped copy yet): ${rows.length}\n`)

let madeCopy = 0, noAnchor = 0, failed = 0
for (const r of rows) {
  const short = String(r.file_name).slice(0, 46)
  const { data: blob, error } = await sb.storage.from("submittals").download(r.storage_path)
  if (error || !blob) { failed++; console.log(`✗ download-fail  ${short}`); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  let res
  try { res = await stripBuffer(buffer) } catch (e) { failed++; console.log(`✗ strip-threw  ${short}  ${e?.message}`); continue }
  if (!res.out) { noAnchor++; console.log(`· original (no anchor)  ${short}`); continue }

  const strippedPath = `${r.company_id}/library-stripped/${crypto.randomUUID()}_${safeBase(r.file_name)}.pdf`
  const up = await sb.storage.from("submittals").upload(strippedPath, res.out, { contentType: "application/pdf", upsert: false })
  if (up.error) { failed++; console.log(`✗ upload-fail  ${short}  ${up.error.message}`); continue }
  const upd = await c.query(`UPDATE submittals SET stripped_storage_path = $1 WHERE id = $2`, [strippedPath, r.id])
  if (upd.rowCount !== 1) { failed++; console.log(`✗ update-fail  ${short}`); continue }
  madeCopy++
  console.log(`✓ STRIPPED ${res.plan.stripStart}-${res.plan.stripEnd}/${res.plan.total} → copy  ${short}`)
}

console.log(`\n══ RESULT ══`)
console.log(`  stripped copy made: ${madeCopy}`)
console.log(`  original (no anchor): ${noAnchor}`)
console.log(`  failed: ${failed}`)
console.log(`  total: ${rows.length}`)
await c.end()
