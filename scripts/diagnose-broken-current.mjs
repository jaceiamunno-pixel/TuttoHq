// scripts/diagnose-broken-current.mjs
//
// READ-ONLY: for Sub 155 and Sub 96 R2 (the two submittals whose
// attachments are ALL is_current=false), pull every attachment row
// (regardless of is_current) and the parent submittal's denormalized
// state. We need:
//   - which attachment SHOULD be current (newest revision_label, then
//     newest uploaded_at as tiebreaker)
//   - whether any R3+ attachment exists that's been overlooked
//   - the current stale state of the parent submittals row

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
})
await client.connect()

const SUBMITTAL_IDS = [
  "49e2aee0-8414-4414-8ef0-f57508bff3f2", // Sub 155 Metal Lockers
  "5b4011b8-92c0-4ca2-ba0f-221b1a955f81", // Sub 96 R2 Ceramic Tile
]

for (const sid of SUBMITTAL_IDS) {
  console.log(`\n══════════════════════════════════════════════════════════════════════`)
  const { rows: subRows } = await client.query(`
    SELECT id, submittal_seq, submittal_number, revision_number, file_name,
           file_sha256, storage_path, status, source, project_id,
           received_at, sent_to_ae_date, returned_from_ae_date
    FROM submittals WHERE id = $1
  `, [sid])
  if (subRows.length === 0) { console.log(`Submittal ${sid} NOT FOUND`); continue }
  const s = subRows[0]
  console.log(`Submittal ${s.id}`)
  console.log(`  Sub ${s.submittal_seq ?? "?"} ${s.submittal_number ? `(GC#${s.submittal_number})` : ""} rev=${s.revision_number}`)
  console.log(`  file_name:        ${s.file_name}`)
  console.log(`  parent.storage_path: ${s.storage_path}`)
  console.log(`  parent.file_sha256:  ${s.file_sha256 ? s.file_sha256.slice(0, 16) + "…" : "NULL"}`)
  console.log(`  status: ${s.status}  source: ${s.source}`)
  console.log(`  received_at:        ${s.received_at?.toISOString?.() ?? "—"}`)
  console.log(`  sent_to_ae_date:    ${s.sent_to_ae_date ?? "—"}`)
  console.log(`  returned_from_ae_date: ${s.returned_from_ae_date ?? "—"}`)

  console.log(`\n  All attachment rows (ALL revisions, ALL is_current values):`)
  const { rows: atts } = await client.query(`
    SELECT id, is_current, revision_label, uploaded_at, uploaded_by,
           storage_path, file_name, file_sha256,
           approval_date, submitted_date, review_status, submittal_number, source
    FROM submittal_attachments
    WHERE submittal_id = $1
    ORDER BY uploaded_at
  `, [sid])
  if (atts.length === 0) {
    console.log("    (no attachment rows — submittal is in a placeholder/empty state)")
  }
  for (const a of atts) {
    console.log(`    att ${a.id.slice(0, 8)}  rev=${a.revision_label}  is_current=${a.is_current}  uploaded_at=${a.uploaded_at?.toISOString?.() ?? "—"}`)
    console.log(`      storage_path: ${a.storage_path}`)
    console.log(`      file_name:    ${a.file_name}`)
    console.log(`      file_sha256:  ${a.file_sha256 ? a.file_sha256.slice(0, 16) + "…" : "NULL"}`)
    console.log(`      approval_date=${a.approval_date ?? "—"}  submitted_date=${a.submitted_date ?? "—"}  review_status=${a.review_status ?? "—"}  source=${a.source}`)
  }

  // Determine which attachment SHOULD be current by the RPC's own logic:
  // 1) highest numeric revision_label (R0=0, R1=1, R2=2, …)
  // 2) within same revision: latest approval_date wins (NULLs lose)
  // 3) final tiebreaker (proposed): latest uploaded_at — newest commit
  const ranked = [...atts].map(a => {
    const num = parseInt((a.revision_label?.match(/\d+/) ?? ["0"])[0], 10)
    return { ...a, _rev_num: num }
  }).sort((x, y) => {
    if (x._rev_num !== y._rev_num) return y._rev_num - x._rev_num
    const ax = x.approval_date ? new Date(x.approval_date).valueOf() : -Infinity
    const ay = y.approval_date ? new Date(y.approval_date).valueOf() : -Infinity
    if (ax !== ay) return ay - ax
    return (new Date(y.uploaded_at).valueOf()) - (new Date(x.uploaded_at).valueOf())
  })
  if (ranked.length > 0) {
    const winner = ranked[0]
    console.log(`\n  PROPOSED FIX: set attachment ${winner.id} (rev=${winner.revision_label}, uploaded_at=${winner.uploaded_at?.toISOString?.()}) to is_current=true`)
    console.log(`    Reason: highest revision_label numeric; tied by approval_date (latest wins, NULL loses); tied by uploaded_at (latest commit wins)`)
  }
}

await client.end()
