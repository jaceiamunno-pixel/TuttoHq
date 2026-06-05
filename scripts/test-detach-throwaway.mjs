// scripts/test-detach-throwaway.mjs
//
// Belt-and-suspenders test of the spec_ingestion DETACH path BEFORE the
// Library delete button goes live. Creates a THROWAWAY spec_ingestion
// submittal + attachment (clearly marked, high seq), populates it as if a
// file were attached, then runs the EXACT DB mutation the endpoint performs
// (delete attachments + DETACH_RESET update), shows before/after, asserts
// the log identity survived and only file fields were nulled, then HARD
// DELETES the throwaway row so production is left exactly as it was.
//
// This is a real run against the real DB on a real (disposable) row — not a
// dry-run. Cleanup removes the test row entirely at the end (and on error).

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await c.connect()

// Mirror of the endpoint's DETACH_RESET (must stay in sync).
const DETACH_RESET = {
  storage_path: null, file_size: null, mime_type: null, file_sha256: null,
  received_file_name: null, returned_from_ae_date: null, sent_to_ae_date: null,
  received_at: null, submittal_number: null, review_status: "Received", revision_number: "00",
}

let testId = null
try {
  // Borrow a real company / project / spec_section / user to satisfy FKs.
  const { rows: [ctx] } = await c.query(`
    SELECT s.company_id, s.project_id, s.spec_section_id, s.uploaded_by
    FROM submittals s
    WHERE s.source='spec_ingestion' AND s.spec_section_id IS NOT NULL
    LIMIT 1
  `)
  console.log("Borrowed FK context:", ctx)

  // 1. Create throwaway spec_ingestion submittal, populated as if attached.
  const ins = await c.query(`
    INSERT INTO submittals (
      company_id, project_id, spec_section_id, uploaded_by, source, status,
      file_name, received_file_name, csi_division, division_name, csi_section,
      section_name, material_name, submittal_type, submittal_seq,
      storage_path, file_size, mime_type, file_sha256,
      review_status, revision_number, submittal_number,
      returned_from_ae_date, sent_to_ae_date, received_at
    ) VALUES (
      $1,$2,$3,$4,'spec_ingestion','active',
      'ZZZ_TEST_DETACH — DELETE ME','ZZZ_TEST_DETACH — DELETE ME','09','Finishes','09 99 99',
      'Test Section','Test Material','Product Data',99999,
      'TESTPATH/uploads/throwaway_detach_test.pdf', 12345, 'application/pdf', repeat('a',64),
      'Approved','R2','999',
      '2026-02-16','2026-01-30','2026-06-03'
    ) RETURNING id
  `, [ctx.company_id, ctx.project_id, ctx.spec_section_id, ctx.uploaded_by])
  testId = ins.rows[0].id

  // 2. Create throwaway attachment.
  await c.query(`
    INSERT INTO submittal_attachments (
      submittal_id, company_id, storage_path, file_name, file_size, mime_type,
      revision_label, is_current, approval_date, review_status, submittal_number,
      file_sha256, uploaded_by, source
    ) VALUES (
      $1,$2,'TESTPATH/uploads/throwaway_detach_test.pdf','throwaway_detach_test.pdf',12345,'application/pdf',
      'R2', true, '2026-02-16','Approved','999', repeat('a',64), $3, 'manual'
    )
  `, [testId, ctx.company_id, ctx.uploaded_by])

  const cols = "id, submittal_seq, file_name, csi_section, section_name, submittal_type, project_id, spec_section_id, source, status, storage_path, file_size, mime_type, file_sha256, received_file_name, submittal_number, revision_number, review_status, returned_from_ae_date, sent_to_ae_date, received_at"
  const before = (await c.query(`SELECT ${cols} FROM submittals WHERE id=$1`, [testId])).rows[0]
  const beforeAtt = (await c.query(`SELECT COUNT(*)::int n FROM submittal_attachments WHERE submittal_id=$1`, [testId])).rows[0].n
  console.log("\n=== BEFORE detach ===")
  console.log(JSON.stringify(before, null, 1))
  console.log("attachment count:", beforeAtt)

  // 3. RUN THE ENDPOINT'S EXACT MUTATION (spec branch).
  await c.query(`DELETE FROM submittal_attachments WHERE submittal_id=$1`, [testId])
  const setClause = Object.keys(DETACH_RESET).map((k, i) => `${k}=$${i + 2}`).join(", ")
  await c.query(`UPDATE submittals SET ${setClause} WHERE id=$1`, [testId, ...Object.values(DETACH_RESET)])

  const after = (await c.query(`SELECT ${cols} FROM submittals WHERE id=$1`, [testId])).rows[0]
  const afterAtt = (await c.query(`SELECT COUNT(*)::int n FROM submittal_attachments WHERE submittal_id=$1`, [testId])).rows[0].n
  console.log("\n=== AFTER detach ===")
  console.log(JSON.stringify(after, null, 1))
  console.log("attachment count:", afterAtt)

  // 4. Assertions.
  console.log("\n=== ASSERTIONS ===")
  const identity = ["id", "submittal_seq", "file_name", "csi_section", "section_name", "submittal_type", "project_id", "spec_section_id", "source", "status"]
  let ok = true
  for (const f of identity) {
    const same = JSON.stringify(before[f]) === JSON.stringify(after[f])
    if (!same) ok = false
    console.log(`  ${same ? "✓" : "✗"} identity preserved: ${f} = ${JSON.stringify(after[f])}`)
  }
  const nulled = ["storage_path", "file_size", "mime_type", "file_sha256", "received_file_name", "submittal_number", "returned_from_ae_date", "sent_to_ae_date", "received_at"]
  for (const f of nulled) {
    const isNull = after[f] === null
    if (!isNull) ok = false
    console.log(`  ${isNull ? "✓" : "✗"} file field nulled: ${f} = ${JSON.stringify(after[f])}`)
  }
  const defaults = after.review_status === "Received" && after.revision_number === "00"
  if (!defaults) ok = false
  console.log(`  ${defaults ? "✓" : "✗"} workflow reset to parser defaults: review_status=${JSON.stringify(after.review_status)} revision_number=${JSON.stringify(after.revision_number)}`)
  console.log(`  ${afterAtt === 0 ? "✓" : "✗"} attachments removed: ${afterAtt}`)
  console.log(`  ${after.status === "active" ? "✓" : "✗"} row still active (NOT deleted): status=${after.status}`)

  console.log(`\n${ok && afterAtt === 0 && after.status === "active" ? "PASS — spec detach preserves the log row, only file fields cleared." : "FAIL"}`)
} finally {
  // 5. Cleanup — hard-delete the throwaway row (cascades any attachment).
  if (testId) {
    await c.query(`DELETE FROM submittals WHERE id=$1`, [testId])
    console.log(`\nCleanup: throwaway row ${testId} hard-deleted. Production unchanged.`)
  }
  await c.end()
}
