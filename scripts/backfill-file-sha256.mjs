// scripts/backfill-file-sha256.mjs
//
// One-shot backfill for Part C (exact-duplicate detection). Read-only on
// storage — downloads each file, computes SHA-256, writes the hash back to
// the row. NEVER deletes anything. NEVER overwrites a non-null existing
// hash. Idempotent: re-running is a no-op for rows already hashed.
//
// WHAT GETS HASHED:
//   1. Every submittal_attachments row with storage_path NOT NULL and
//      file_sha256 NULL (most rows — these are the per-revision files).
//      Updating the attachment row's hash will trigger the sync trigger
//      to propagate the hash to submittals.file_sha256 when is_current.
//
//   2. Every submittals row with storage_path NOT NULL, file_sha256 NULL,
//      AND status <> 'deleted', AND no submittal_attachments row exists.
//      This catches direct Library uploads that pre-date the attachments
//      backfill. (After the trigger fires in step 1, this set should
//      already cover anything missing.)
//
// REPORT AT END:
//   - Total files hashed
//   - Skipped (already hashed / download failed)
//   - Duplicate clusters: groups of >=2 rows sharing the same hash,
//     within the same company, with project info. Read-only. Cleanup
//     is a separate careful-lane step — review the cluster list FIRST.
//
// USAGE:
//   node scripts/backfill-file-sha256.mjs
//
// REQUIRES the file-sha256 migration applied first.

import { createClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

// Load .env.local manually (same pattern as the test-strip script)
try {
  const env = readFileSync(".env.local", "utf-8")
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
  }
} catch (err) {
  console.error("Failed to read .env.local — make sure you're running from the repo root.")
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local")
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

const BATCH = 50   // hash N files at a time before checkpointing
const CONCURRENCY = 4 // parallel downloads inside each batch

async function hashOne(row, table) {
  // Skip if already hashed (idempotent guard for in-flight re-runs)
  if (row.file_sha256) return { row, action: "skip-already-hashed" }
  if (!row.storage_path) return { row, action: "skip-no-storage-path" }

  const { data: blob, error: dlErr } = await sb.storage
    .from("submittals")
    .download(row.storage_path)
  if (dlErr || !blob) {
    return { row, action: "skip-download-failed", error: dlErr?.message ?? "no blob" }
  }

  const buffer = Buffer.from(await blob.arrayBuffer())
  const sha = createHash("sha256").update(buffer).digest("hex")

  const { error: upErr } = await sb
    .from(table)
    .update({ file_sha256: sha })
    .eq("id", row.id)
  if (upErr) {
    return { row, action: "skip-update-failed", error: upErr.message }
  }
  return { row, action: "hashed", sha }
}

async function processBatch(rows, table) {
  const out = []
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY)
    const results = await Promise.all(slice.map(r => hashOne(r, table)))
    out.push(...results)
  }
  return out
}

async function backfillTable(table, label) {
  console.log(`\n══ ${label} ${"═".repeat(70 - label.length)}`)
  let totalProcessed = 0, totalHashed = 0, totalSkipped = 0, totalFailed = 0

  for (;;) {
    // Pull a page of unhashed rows. Use range pagination so we can keep
    // going as we mark rows hashed (we always re-query unhashed only).
    let q = sb.from(table)
      .select("id, company_id, storage_path, file_name, file_sha256")
      .is("file_sha256", null)
      .not("storage_path", "is", null)
      .limit(BATCH)

    // For submittals, exclude soft-deleted (don't waste cycles)
    if (table === "submittals") {
      q = q.neq("status", "deleted")
    }

    const { data: rows, error } = await q
    if (error) {
      console.error(`  query failed: ${error.message}`)
      break
    }
    if (!rows || rows.length === 0) break

    const results = await processBatch(rows, table)
    for (const r of results) {
      totalProcessed++
      if (r.action === "hashed") totalHashed++
      else if (r.action.startsWith("skip")) {
        if (r.action === "skip-download-failed" || r.action === "skip-update-failed") {
          totalFailed++
          console.warn(`  ✗ ${r.row.file_name}: ${r.action} — ${r.error ?? ""}`)
        } else {
          totalSkipped++
        }
      }
    }
    process.stdout.write(`  ${totalProcessed} processed (${totalHashed} hashed, ${totalSkipped} skipped, ${totalFailed} failed)\r`)
  }
  process.stdout.write("\n")
  return { totalProcessed, totalHashed, totalSkipped, totalFailed }
}

async function reportDuplicates() {
  console.log("\n══ DUPLICATE CLUSTERS ═════════════════════════════════════════════════")
  console.log("Same SHA-256 = byte-identical PDFs. Same-company only. Grouped by hash.")
  console.log("This is a REPORT. No rows are modified. Cleanup is a separate step.\n")

  // Fetch ALL rows with file_sha256 NOT NULL — usually a few hundred at most,
  // even for power users. Pull from submittals (denormalized current hash)
  // since that's the per-submittal view the user cares about.
  const { data: rows, error } = await sb
    .from("submittals")
    .select("id, company_id, project_id, file_name, file_sha256, submittal_seq, submittal_number, revision_number, status, received_at")
    .not("file_sha256", "is", null)
    .neq("status", "deleted")

  if (error) {
    console.error(`  duplicate report query failed: ${error.message}`)
    return
  }
  if (!rows || rows.length === 0) {
    console.log("  No rows with file_sha256 — backfill may not have run yet.")
    return
  }

  // Group by (company_id, file_sha256). Only report clusters of >= 2.
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.company_id}::${r.file_sha256}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const clusters = Array.from(groups.entries())
    .filter(([, g]) => g.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)

  if (clusters.length === 0) {
    console.log("  No exact-byte duplicate clusters found across the corpus.")
    return
  }

  // Look up project names in one round-trip
  const projectIds = new Set()
  for (const [, group] of clusters) for (const r of group) if (r.project_id) projectIds.add(r.project_id)
  const { data: projects } = await sb.from("projects").select("id, name").in("id", Array.from(projectIds))
  const projectName = new Map((projects ?? []).map(p => [p.id, p.name]))

  let totalDupeRows = 0, sameProjectClusters = 0, crossProjectClusters = 0
  for (const [key, group] of clusters) {
    const [company, sha] = key.split("::")
    totalDupeRows += group.length
    const distinctProjects = new Set(group.map(r => r.project_id).filter(Boolean))
    const sameProject = distinctProjects.size <= 1
    if (sameProject) sameProjectClusters++; else crossProjectClusters++

    console.log(`\n  ${sameProject ? "⚠ SAME PROJECT" : "○ CROSS PROJECT"}  hash ${sha.slice(0, 12)}…  ${group.length} rows`)
    console.log(`     company: ${company}`)
    for (const r of group) {
      const proj = r.project_id ? (projectName.get(r.project_id) ?? r.project_id.slice(0, 8)) : "(no project)"
      const subRef = r.submittal_seq != null ? `Sub ${r.submittal_seq}` : (r.submittal_number ?? "")
      const rev = r.revision_number ? ` (${r.revision_number})` : ""
      console.log(`       · ${proj} — ${subRef}${rev}: ${r.file_name}`)
    }
  }

  console.log(`\n══ TOTAL ══════════════════════════════════════════════════════════════`)
  console.log(`  ${clusters.length} duplicate clusters (${totalDupeRows} rows total)`)
  console.log(`  ${sameProjectClusters} same-project clusters (the real "accidental upload" cases)`)
  console.log(`  ${crossProjectClusters} cross-project clusters (often legit — same datasheet across jobs)`)
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log("Part C backfill — SHA-256 of file bytes. READ-ONLY (no deletes).")
  console.log("══════════════════════════════════════════════════════════════════════")

  const t0 = Date.now()
  const a = await backfillTable("submittal_attachments", "submittal_attachments (per-revision files)")
  const b = await backfillTable("submittals",            "submittals (direct uploads with no attachment row)")
  const t1 = Date.now()

  console.log(`\nDone in ${((t1 - t0) / 1000).toFixed(1)}s. ` +
    `attachments: ${a.totalHashed} hashed, ${a.totalSkipped} skipped, ${a.totalFailed} failed. ` +
    `submittals: ${b.totalHashed} hashed, ${b.totalSkipped} skipped, ${b.totalFailed} failed.`)

  await reportDuplicates()
}

main().catch(err => {
  console.error("backfill failed:", err)
  process.exit(1)
})
