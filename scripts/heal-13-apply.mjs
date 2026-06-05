// Apply the approved heal-the-13 corrections. For each of the 13
// committed Waters submittals:
//   - Extract Text4 (GC's submission date) and the architect Stamp
//     /CreationDate from the PDF.
//   - UPDATE submittal_attachments SET approval_date = stamp,
//     submitted_date = Text4 WHERE submittal_id = <row> AND is_current.
//   - The trigger propagates both to submittals.returned_from_ae_date
//     and .sent_to_ae_date respectively.
//
// Sub 118 special-case: its current returned_from_ae_date (2026-06-12)
// matches neither Text4 nor the stamp date — discard it, set both
// fields to the recovered values.
//
// Writes via service role. Reports per-row before/after.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFTextField, PDFDict, PDFArray } from "pdf-lib"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PROJECT_ID = "350ee2a5-49e4-4675-9826-ada407a53d3d"

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
  return `${fullY}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
}
async function extractDates(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
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
      const parsed = parsePdfDate(annot.get(doc.context.obj("CreationDate"))?.toString?.())
      if (parsed && (!stampDate || parsed < stampDate)) stampDate = parsed
    }
  }
  return { submittedDate: normUsDate(text4Raw), stampDate, text4Raw }
}

// Pull the 13 + their current attachment ids
const { data: rows, error } = await a
  .from("submittals")
  .select(`
    id::text, csi_section, submittal_type, submittal_number,
    returned_from_ae_date, sent_to_ae_date,
    storage_path
  `)
  .eq("project_id", PROJECT_ID)
  .eq("source", "spec_ingestion")
  .neq("status", "deleted")
  .not("storage_path", "is", null)
  .order("csi_section")
if (error) { console.error(error.message); process.exit(1) }

console.log("Healing", rows.length, "rows…\n")
console.log("Sub#    | section · type           | OLD approval  | NEW approval (stamp) | NEW submitted (Text4) | result")
console.log("--------+--------------------------+---------------+----------------------+-----------------------+--------")

let updated = 0, errored = 0, skipped = 0
for (const r of rows) {
  const { data: blob, error: dlErr } = await a.storage.from("submittals").download(r.storage_path)
  if (dlErr) {
    console.log(`${(r.submittal_number ?? "?").padEnd(7)} | ${r.csi_section} ${(r.submittal_type ?? "").padEnd(13)} | ERR: ${dlErr.message}`)
    errored++; continue
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const { submittedDate, stampDate } = await extractDates(buffer)

  if (!stampDate) {
    console.log(`${(r.submittal_number ?? "?").padEnd(7)} | ${r.csi_section} ${(r.submittal_type ?? "").padEnd(13)} | SKIP — no stamp found`)
    skipped++; continue
  }

  // Locate current attachment to update
  const { data: att, error: attErr } = await a
    .from("submittal_attachments")
    .select("id, approval_date, submitted_date")
    .eq("submittal_id", r.id)
    .eq("is_current", true)
    .maybeSingle()
  if (attErr || !att) {
    console.log(`${(r.submittal_number ?? "?").padEnd(7)} | ${r.csi_section} ${(r.submittal_type ?? "").padEnd(13)} | ERR: attachment lookup`)
    errored++; continue
  }

  // Apply atomic update — both columns in one statement so the trigger fires once.
  const { error: uErr } = await a
    .from("submittal_attachments")
    .update({ approval_date: stampDate, submitted_date: submittedDate })
    .eq("id", att.id)
  if (uErr) {
    console.log(`${(r.submittal_number ?? "?").padEnd(7)} | ${r.csi_section} ${(r.submittal_type ?? "").padEnd(13)} | ERR: ${uErr.message}`)
    errored++; continue
  }

  const oldApp = String(r.returned_from_ae_date ?? "null").padEnd(13)
  console.log(`${(r.submittal_number ?? "?").padEnd(7)} | ${r.csi_section} ${(r.submittal_type ?? "").padEnd(13)} | ${oldApp} | ${String(stampDate).padEnd(20)} | ${String(submittedDate ?? "null").padEnd(21)} | OK`)
  updated++
}

console.log("\n────────── SUMMARY ──────────")
console.log("Updated:", updated)
console.log("Errored:", errored)
console.log("Skipped:", skipped)

// Verify final state by re-pulling
console.log("\n────────── VERIFY: final returned_from_ae_date + sent_to_ae_date ──────────")
const { data: final } = await a
  .from("submittals")
  .select("submittal_number, csi_section, submittal_type, returned_from_ae_date, sent_to_ae_date")
  .eq("project_id", PROJECT_ID)
  .eq("source", "spec_ingestion")
  .neq("status", "deleted")
  .not("storage_path", "is", null)
  .order("csi_section")
for (const r of final ?? []) {
  console.log(`  Sub#${(r.submittal_number ?? "?").padEnd(7)} ${r.csi_section} ${(r.submittal_type ?? "").padEnd(13)}  approval=${r.returned_from_ae_date ?? "null"}  submitted=${r.sent_to_ae_date ?? "null"}`)
}
