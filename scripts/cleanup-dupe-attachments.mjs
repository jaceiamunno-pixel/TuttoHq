// scripts/cleanup-dupe-attachments.mjs
//
// Cleanup for the same-submittal redundant attachment rows created by
// the historical double-commit bug (now closed by the idempotency
// guard). DRY-RUN BY DEFAULT — prints the full plan + exact SQL +
// storage-remove paths and exits without touching anything. Pass
// --apply to execute.
//
// TARGET SET: groups of submittal_attachments sharing
//   (submittal_id, file_sha256, revision_label)
// with COUNT >= 2. Grouping by submittal_id means CROSS-submittal
// clusters (Steel Stud, 3M) are NATURALLY EXCLUDED — their rows have
// distinct submittal_ids, so each lands in a group of 1. Grouping by
// revision_label means an intentional relabel (same bytes, new label —
// which the guard explicitly allows) is also excluded.
//
// PER GROUP:
//   survivor = the is_current=true row if one exists; else the earliest
//              uploaded_at row (the original commit). NEVER deleted.
//   victims  = every other row in the group. Each is asserted
//              is_current=false before any delete.
//
// SAFETY (all checked before --apply does anything):
//   1. No victim is is_current=true.
//   2. After deletion, every affected submittal still has exactly ONE
//      is_current=true attachment.
//   3. A victim's storage object is removed ONLY if no surviving row
//      (any attachment) and no submittals.storage_path references it.
//
// ON --apply:
//   - Writes a JSON audit of every victim row + removed path to
//     scripts/cleanup-audit-<timestamp>.json BEFORE executing (this is
//     the "soft" record — hard-deleting the row + removing the storage
//     object is the only COHERENT operation, since a soft-deleted row
//     pointing at a removed file would be a dangling reference).
//   - DB deletes run in a single transaction with an in-txn re-check of
//     invariant #2; ROLLBACK if it fails.
//   - Storage removals run after COMMIT (storage isn't transactional).

import { readFileSync, writeFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const APPLY = process.argv.includes("--apply")

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await client.connect()

const projectNames = new Map()
for (const r of (await client.query(`SELECT id, name FROM projects`)).rows) projectNames.set(r.id, r.name)

// ── 1. Pull every member of every same-submittal dupe group ───────────
const { rows: members } = await client.query(`
  WITH groups AS (
    SELECT submittal_id, file_sha256, revision_label
    FROM submittal_attachments
    WHERE file_sha256 IS NOT NULL
    GROUP BY submittal_id, file_sha256, revision_label
    HAVING COUNT(*) >= 2
  )
  SELECT sa.id, sa.submittal_id, sa.file_sha256, sa.revision_label,
         sa.is_current, sa.uploaded_at, sa.storage_path, sa.file_name,
         s.submittal_seq, s.file_name AS sub_name, s.project_id,
         s.source, s.storage_path AS parent_storage_path, s.status AS sub_status
  FROM submittal_attachments sa
  JOIN groups g
    ON g.submittal_id = sa.submittal_id
   AND g.file_sha256 = sa.file_sha256
   AND g.revision_label = sa.revision_label
  JOIN submittals s ON s.id = sa.submittal_id
  ORDER BY sa.submittal_id, sa.file_sha256, sa.revision_label, sa.uploaded_at
`)

// ── 2. Build groups in memory ─────────────────────────────────────────
const groupMap = new Map()
for (const m of members) {
  const key = `${m.submittal_id}::${m.file_sha256}::${m.revision_label}`
  if (!groupMap.has(key)) groupMap.set(key, [])
  groupMap.get(key).push(m)
}

const plan = []        // { group, survivor, victims:[{row, orphan:bool, refCount}] }
const aborts = []      // safety violations

for (const [key, rows] of groupMap) {
  const currents = rows.filter(r => r.is_current === true)
  let survivor
  if (currents.length === 1) survivor = currents[0]
  else if (currents.length === 0) survivor = [...rows].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at))[0]
  else { aborts.push({ key, reason: `group has ${currents.length} is_current=true rows — ambiguous, not auto-cleanable` }); continue }

  const victims = rows.filter(r => r.id !== survivor.id)
  for (const v of victims) {
    if (v.is_current === true) { aborts.push({ key, reason: `victim ${v.id} is is_current=true — refusing` }); }
  }
  plan.push({ key, survivor, victims })
}

// ── 3. Orphan check for each victim storage_path ──────────────────────
const allVictimIds = plan.flatMap(p => p.victims.map(v => v.id))
for (const p of plan) {
  for (const v of p.victims) {
    // Any OTHER attachment row (not a victim) referencing this path?
    const { rows: [{ n: attRefs }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM submittal_attachments
        WHERE storage_path = $1 AND NOT (id = ANY($2::uuid[]))`,
      [v.storage_path, allVictimIds],
    )
    // Any submittals row referencing this path?
    const { rows: [{ n: subRefs }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM submittals WHERE storage_path = $1`,
      [v.storage_path],
    )
    v._refsAfterDelete = attRefs + subRefs
    v._orphan = (attRefs + subRefs) === 0
  }
}

// ── 4. Invariant #2 preview: each affected submittal ends with exactly
//       one is_current=true attachment ───────────────────────────────
const affectedSubmittalIds = [...new Set(plan.map(p => p.survivor.submittal_id))]
const currentCounts = new Map()
for (const sid of affectedSubmittalIds) {
  const { rows: [{ n }] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM submittal_attachments
      WHERE submittal_id = $1 AND is_current = true AND NOT (id = ANY($2::uuid[]))`,
    [sid, allVictimIds],
  )
  currentCounts.set(sid, n)
}

// ── 5. PRINT THE PLAN ─────────────────────────────────────────────────
console.log("═".repeat(78))
console.log(`Cleanup ${APPLY ? "APPLY" : "DRY-RUN"} — same-submittal redundant attachments`)
console.log("═".repeat(78))
console.log(`Dupe groups found: ${plan.length}   victims to delete: ${allVictimIds.length}`)
console.log(`Affected submittals: ${affectedSubmittalIds.length}\n`)

let i = 0
for (const p of plan) {
  i++
  const s = p.survivor
  const proj = s.project_id ? (projectNames.get(s.project_id) ?? s.project_id.slice(0, 8)) : "(no project)"
  console.log(`${String(i).padStart(2)}. Sub ${s.submittal_seq ?? "?"} · ${proj} · "${s.sub_name}" · rev=${s.revision_label} · hash ${s.file_sha256.slice(0, 12)}…`)
  console.log(`     KEEP   att ${s.id}  is_current=${s.is_current}  uploaded_at=${s.uploaded_at?.toISOString?.()}`)
  console.log(`            path ${s.storage_path}`)
  for (const v of p.victims) {
    console.log(`     DELETE att ${v.id}  is_current=${v.is_current}  uploaded_at=${v.uploaded_at?.toISOString?.()}`)
    console.log(`            path ${v.storage_path}`)
    console.log(`            storage object → ${v._orphan ? "REMOVE (orphan, 0 refs after delete)" : `KEEP (${v._refsAfterDelete} other ref(s) — NOT orphan)`}`)
  }
  const cc = currentCounts.get(s.submittal_id)
  console.log(`     post-delete is_current count for this submittal: ${cc} ${cc === 1 ? "✓" : "✗ ABORT-WORTHY"}`)
  console.log()
}

// ── 6. Safety summary ─────────────────────────────────────────────────
const badCurrentCounts = [...currentCounts.entries()].filter(([, n]) => n !== 1)
console.log("─".repeat(78))
console.log("SAFETY CHECKS")
console.log(`  victims all is_current=false:        ${allVictimIds.length > 0 && plan.every(p => p.victims.every(v => v.is_current === false)) ? "PASS" : "FAIL"}`)
console.log(`  every affected submittal ends w/ 1 current: ${badCurrentCounts.length === 0 ? "PASS" : "FAIL — " + JSON.stringify(badCurrentCounts)}`)
console.log(`  groups aborted for ambiguity:        ${aborts.length === 0 ? "none" : JSON.stringify(aborts, null, 2)}`)

// ── 7. Exact SQL + storage list ───────────────────────────────────────
const orphanPaths = plan.flatMap(p => p.victims.filter(v => v._orphan).map(v => v.storage_path))
const keepStoragePaths = plan.flatMap(p => p.victims.filter(v => !v._orphan).map(v => v.storage_path))
console.log("\n" + "─".repeat(78))
console.log("EXACT SQL (DB):")
console.log(`  DELETE FROM submittal_attachments WHERE id IN (`)
console.log(allVictimIds.map(id => `    '${id}'`).join(",\n"))
console.log(`  );  -- ${allVictimIds.length} rows`)
console.log("\nSTORAGE OBJECTS TO REMOVE (bucket: submittals):")
for (const path of orphanPaths) console.log(`  - ${path}`)
if (keepStoragePaths.length) {
  console.log("\nSTORAGE OBJECTS LEFT IN PLACE (still referenced — NOT orphan):")
  for (const path of keepStoragePaths) console.log(`  - ${path}`)
}

if (aborts.length > 0 || badCurrentCounts.length > 0) {
  console.log("\n⛔ Safety checks failed — apply is BLOCKED even with --apply. Resolve aborts first.")
  await client.end()
  process.exit(1)
}

if (!APPLY) {
  console.log("\nDRY-RUN complete. No changes made. Re-run with --apply to execute.")
  await client.end()
  process.exit(0)
}

// ── 8. APPLY ──────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(78))
console.log("APPLYING…")

// 8a. Audit file FIRST (the "soft" record).
const auditPath = `scripts/cleanup-audit-${Date.now()}.json`
const audit = {
  ran_at: new Date().toISOString(),
  victims: plan.flatMap(p => p.victims.map(v => ({
    submittal_id: v.submittal_id, attachment_id: v.id, file_sha256: v.file_sha256,
    revision_label: v.revision_label, is_current: v.is_current, storage_path: v.storage_path,
    file_name: v.file_name, orphan_storage_removed: v._orphan,
    survivor_attachment_id: p.survivor.id, survivor_storage_path: p.survivor.storage_path,
  }))),
  orphan_paths_removed: orphanPaths,
}
writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf-8")
console.log(`  Audit written: ${auditPath}`)

// 8b. DB deletes in one transaction + in-txn invariant re-check.
await client.query("BEGIN")
try {
  const del = await client.query(
    `DELETE FROM submittal_attachments WHERE id = ANY($1::uuid[])`, [allVictimIds],
  )
  console.log(`  Deleted ${del.rowCount} attachment rows`)
  for (const sid of affectedSubmittalIds) {
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM submittal_attachments WHERE submittal_id = $1 AND is_current = true`, [sid],
    )
    if (n !== 1) throw new Error(`submittal ${sid} would have ${n} current attachments — ROLLBACK`)
  }
  await client.query("COMMIT")
  console.log("  DB transaction COMMITTED — every affected submittal has exactly 1 current.")
} catch (err) {
  await client.query("ROLLBACK")
  console.error(`  ✗ ROLLED BACK: ${err.message}`)
  await client.end()
  process.exit(1)
}

// 8c. Storage removals (post-commit; not transactional).
let removed = 0, failed = 0
for (const path of orphanPaths) {
  const { error } = await sb.storage.from("submittals").remove([path])
  if (error) { failed++; console.warn(`  ✗ storage remove failed: ${path} — ${error.message}`) }
  else removed++
}
console.log(`  Storage: ${removed} removed, ${failed} failed (of ${orphanPaths.length})`)

await client.end()
console.log("\nAPPLY complete.")
