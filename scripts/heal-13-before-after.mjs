// Build the proposed heal-the-13 table: for each committed Waters row,
// pull Text4 (Waters form widget = GC's "Date Submitted") and the
// architect Stamp /CreationDate. Show current returned_from_ae_date,
// the proposed corrected value (stamp date), and what to do with the
// current value (move to sent_to_ae_date if it matches Text4, else
// flag for replacement-only).
//
// READ-ONLY — outputs the table for user review, no writes.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFDict, PDFArray } from "pdf-lib"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Pull the 13 from DB to get current state.
const { data: rows, error } = await a
  .from("submittals")
  .select(`
    id::text, csi_section, submittal_type, submittal_number,
    returned_from_ae_date, sent_to_ae_date, received_date,
    storage_path
  `)
  .eq("project_id", "350ee2a5-49e4-4675-9826-ada407a53d3d")
  .eq("source", "spec_ingestion")
  .neq("status", "deleted")
  .not("storage_path", "is", null)
  .order("csi_section")

if (error) { console.error(error.message); process.exit(1) }

function parsePdfDate(raw) {
  if (!raw) return null
  const s = String(raw).replace(/^\(D:|^D:|\)$/g, "").replace(/['"]/g, "")
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
function normUsDate(raw) {
  if (!raw) return null
  const m = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return null
  const [, mo, d, y] = m
  const fullY = y.length === 4 ? y : (parseInt(y) <= 50 ? "20" + y : "19" + y)
  return `${fullY}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`
}

const results = []
for (const r of rows) {
  const { data: blob, error: dlErr } = await a.storage.from("submittals").download(r.storage_path)
  if (dlErr) { results.push({ ...r, err: dlErr.message }); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })

  // 1) Text4 from AcroForm
  let text4Raw = null
  try {
    for (const f of doc.getForm().getFields()) {
      const name = f.getName()
      if (name === "Text4#1" || name === "Text4#1#1" || name === "Text4") {
        if (f instanceof PDFTextField) text4Raw = f.getText() ?? null
        break
      }
    }
  } catch {}
  const submittedDate = normUsDate(text4Raw)

  // 2) Stamp /CreationDate — scan first 6 pages
  let stampDate = null
  const pages = doc.getPages()
  for (let p = 0; p < Math.min(pages.length, 6); p++) {
    const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
    if (!annotsRef) continue
    const annots = doc.context.lookup(annotsRef)
    if (!(annots instanceof PDFArray)) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i))
      if (!(annot instanceof PDFDict)) continue
      const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
      if (subtype !== "/Stamp") continue
      const d = annot.get(doc.context.obj("CreationDate"))?.toString?.()
      const parsed = parsePdfDate(d)
      if (parsed && (!stampDate || parsed < stampDate)) stampDate = parsed
    }
  }

  results.push({
    ...r,
    submittedDate,
    text4Raw: text4Raw?.trim() ?? null,
    stampDate,
  })
}

// Print table
console.log("\nHEAL-THE-13 PROPOSED CHANGES (no writes)\n")
console.log("Sub# | section · type           | CURRENT approval (wrong) | NEW approval (stamp date) | NEW submission (Text4)  | Move-current?")
console.log("-----+--------------------------+--------------------------+---------------------------+-------------------------+----------------")
for (const r of results) {
  if (r.err) { console.log(`${(r.submittal_number ?? "?").padEnd(8)} ERROR: ${r.err}`); continue }
  const lhs = `${(r.submittal_number ?? "?").padEnd(7)} | ${r.csi_section} ${(r.submittal_type ?? "").padEnd(15).slice(0, 15)}`
  const cur = (r.returned_from_ae_date ?? "null")
  const newApp = r.stampDate ?? "(no stamp — null+flag)"
  const newSub = r.submittedDate ?? "(Text4 missing)"

  // Note: does the current value match Text4? If yes, it WAS the submission date — move it. If not, flag.
  let action
  if (cur === r.submittedDate) action = "MOVE current → sent_to_ae_date (matches Text4)"
  else if (cur === r.stampDate) action = "NO-OP on current (it already equals stamp)"
  else if (cur && r.submittedDate) action = `REPLACE only (current ${cur} ≠ Text4 ${r.submittedDate})`
  else action = "REPLACE only"

  console.log(`${lhs} | ${cur.padEnd(24)} | ${newApp.padEnd(25)} | ${newSub.padEnd(23)} | ${action}`)
}
