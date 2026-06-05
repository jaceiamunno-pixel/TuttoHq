// scripts/verify-idempotency-guard.mjs
//
// Live verification of the same-bytes idempotency guard on
// add_submittal_attachment. Runs against the prod DB. Uses a transaction
// + ROLLBACK so no permanent changes are made if anything is inserted
// inadvertently.
//
// TEST PLAN:
//   1. Pick a known healthy submittal with a current attachment that
//      has a file_sha256 set.
//   2. Count attachments for that submittal — record N.
//   3. Set the JWT claim to a real user in the company so SECURITY
//      INVOKER's auth.uid() + get_my_company_id() work.
//   4. Call the RPC with (same submittal_id, same file_sha256, same
//      revision_label, but a FAKE new storage_path).
//   5. The RPC should hit the guard and return the existing
//      attachment's id WITHOUT inserting anything.
//   6. Count attachments for that submittal — should still be N.
//   7. ROLLBACK regardless.

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

function pass(msg) { console.log(`  ✓ ${msg}`) }
function fail(msg) { console.log(`  ✗ ${msg}`); process.exitCode = 1 }

try {
  await client.query("BEGIN")

  // ── Pick the test target: an existing healthy submittal with a
  //    current attachment carrying a file_sha256. We use Sub 47
  //    (Cement-Aluminate Mortar) or whatever first qualifies.
  const { rows: targets } = await client.query(`
    SELECT sa.id AS att_id, sa.submittal_id, sa.file_sha256,
           sa.revision_label, sa.storage_path, sa.file_name,
           s.submittal_seq, s.project_id, s.company_id
    FROM submittal_attachments sa
    JOIN submittals s ON s.id = sa.submittal_id AND s.status <> 'deleted'
    WHERE sa.is_current = true
      AND sa.file_sha256 IS NOT NULL
      AND s.source = 'spec_ingestion'
    LIMIT 1
  `)
  if (targets.length === 0) {
    fail("No suitable test target found")
    await client.query("ROLLBACK")
    process.exit(1)
  }
  const t = targets[0]
  console.log("Test target:")
  console.log(`  submittal_id     ${t.submittal_id}`)
  console.log(`  attachment_id    ${t.att_id}  (this is what the guard should return)`)
  console.log(`  file_sha256      ${t.file_sha256.slice(0, 16)}…`)
  console.log(`  revision_label   ${t.revision_label}`)
  console.log(`  existing path    ${t.storage_path}`)

  // ── Count attachments for that submittal — record N ──────────────────
  const { rows: [{ n: countBefore }] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM submittal_attachments WHERE submittal_id = $1`,
    [t.submittal_id],
  )
  console.log(`\n  attachment count BEFORE: ${countBefore}`)

  // ── Find a user in the company so the SECURITY INVOKER auth check
  //    succeeds. Service-role can SELECT auth.users.
  const { rows: users } = await client.query(`
    SELECT u.id
    FROM auth.users u
    WHERE u.raw_user_meta_data->>'company_id' IS NULL  -- doesn't matter, we just need any user in the company
       OR true
    LIMIT 1
  `)
  // Better: pull a user that get_my_company_id() will resolve to this company.
  // Easiest: the user who uploaded the existing attachment.
  const { rows: [origUploader] } = await client.query(
    `SELECT uploaded_by FROM submittal_attachments WHERE id = $1`,
    [t.att_id],
  )
  const userId = origUploader?.uploaded_by ?? users[0]?.id
  if (!userId) {
    fail("No user id resolvable for JWT claim")
    await client.query("ROLLBACK")
    process.exit(1)
  }
  console.log(`  impersonating user ${userId} for auth.uid() / get_my_company_id()`)

  // ── Set the JWT claim. Supabase auth.uid() reads from
  //    current_setting('request.jwt.claim.sub', true). Setting it here
  //    makes the RPC's SECURITY INVOKER path see this uid.
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
  await client.query(`SELECT set_config('role', 'authenticated', true)`)

  // ── First RPC call: should hit the guard and return existing row.
  console.log("\n  --- RPC call #1 (same sid/hash/label, fake new path) ---")
  const fakePath = `${t.submittal_id.slice(0, 8)}/uploads/FAKE_VERIFY_${Date.now()}.pdf`
  const { rows: rpcRows } = await client.query(
    `SELECT * FROM add_submittal_attachment(
       $1::uuid,  -- p_submittal_id
       $2::text,  -- p_storage_path  (fake new path; the guard should ignore it)
       $3::text,  -- p_file_name
       $4::bigint,-- p_file_size
       $5::text,  -- p_revision_label  (SAME as existing)
       NULL,      -- p_approval_date
       NULL,      -- p_review_status
       NULL,      -- p_submittal_number
       'bulk_import',
       NULL,      -- p_submitted_date
       $6::text   -- p_file_sha256  (SAME as existing)
     )`,
    [
      t.submittal_id, fakePath, "verify-test-file.pdf", 12345, t.revision_label, t.file_sha256,
    ],
  )
  const returnedAttId = rpcRows[0]?.id
  const returnedPath  = rpcRows[0]?.storage_path
  console.log(`    returned attachment_id: ${returnedAttId}`)
  console.log(`    returned storage_path:  ${returnedPath}`)

  if (returnedAttId === t.att_id) pass("RPC returned the EXISTING attachment id — guard fired")
  else                            fail(`RPC returned ${returnedAttId} but expected existing ${t.att_id}`)

  if (returnedPath === t.storage_path) pass("Returned storage_path is the EXISTING one (not the fake new one)")
  else                                 fail(`Returned storage_path is ${returnedPath} but expected ${t.storage_path}`)

  // ── Count attachments after — should be unchanged.
  const { rows: [{ n: countAfter }] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM submittal_attachments WHERE submittal_id = $1`,
    [t.submittal_id],
  )
  console.log(`\n  attachment count AFTER:  ${countAfter}`)
  if (countAfter === countBefore) pass(`No new row inserted (count stayed at ${countBefore})`)
  else                            fail(`Count changed from ${countBefore} to ${countAfter} — guard FAILED, INSERT happened`)

  // ── Second RPC call: should also no-op.
  console.log("\n  --- RPC call #2 (re-run; should also no-op) ---")
  const { rows: rpc2 } = await client.query(
    `SELECT * FROM add_submittal_attachment(
       $1::uuid, $2::text, $3::text, $4::bigint, $5::text,
       NULL, NULL, NULL, 'bulk_import', NULL, $6::text
     )`,
    [t.submittal_id, fakePath, "verify-test-file.pdf", 12345, t.revision_label, t.file_sha256],
  )
  if (rpc2[0]?.id === t.att_id) pass("Second call also returned existing — guard is idempotent")
  else                          fail(`Second call returned ${rpc2[0]?.id}, expected ${t.att_id}`)

  // ── Negative test: call with a DIFFERENT revision_label — guard
  //    should fall through (allow INSERT). We don't COMMIT, so it's
  //    rolled back anyway; just verify the count actually increases.
  console.log("\n  --- RPC call #3 (DIFFERENT revision_label — should NOT no-op) ---")
  const fakeNewLabel = t.revision_label === "R0" ? "R99" : "R0_test"
  const { rows: rpc3 } = await client.query(
    `SELECT * FROM add_submittal_attachment(
       $1::uuid, $2::text, $3::text, $4::bigint, $5::text,
       NULL, NULL, NULL, 'bulk_import', NULL, $6::text
     )`,
    [t.submittal_id, fakePath + "_v3", "verify-test-file-v3.pdf", 12345, fakeNewLabel, t.file_sha256],
  )
  const rpc3Id   = rpc3[0]?.id
  const rpc3Path = rpc3[0]?.storage_path
  console.log(`    returned attachment_id: ${rpc3Id}`)
  console.log(`    returned storage_path:  ${rpc3Path}`)
  if (rpc3Id !== t.att_id && rpc3Path === fakePath + "_v3") {
    pass("Different revision_label → RPC INSERTed a new row (guard correctly fell through)")
  } else {
    fail(`Different revision_label test: returned id=${rpc3Id}, path=${rpc3Path} — expected new INSERT`)
  }

  // ── Negative test: call with a DIFFERENT file_sha256 — should INSERT.
  console.log("\n  --- RPC call #4 (DIFFERENT file_sha256 — should NOT no-op) ---")
  const fakeHash = "0".repeat(64)
  const { rows: rpc4 } = await client.query(
    `SELECT * FROM add_submittal_attachment(
       $1::uuid, $2::text, $3::text, $4::bigint, $5::text,
       NULL, NULL, NULL, 'bulk_import', NULL, $6::text
     )`,
    [t.submittal_id, fakePath + "_v4", "verify-test-file-v4.pdf", 12345, t.revision_label, fakeHash],
  )
  if (rpc4[0]?.id !== t.att_id && rpc4[0]?.file_sha256 === fakeHash) {
    pass("Different hash → RPC INSERTed a new row (guard correctly fell through)")
  } else {
    fail(`Different hash test: returned id=${rpc4[0]?.id}, hash=${rpc4[0]?.file_sha256?.slice(0, 16)}`)
  }

  console.log("\nAll RPC writes ROLLED BACK — DB state unchanged.")
} finally {
  await client.query("ROLLBACK").catch(() => {})
  await client.end()
}
