// scripts/diagnose-dupe-clusters.mjs
//
// READ-ONLY diagnostic for the dupe-cluster discrepancy. Compares the
// truth-set (group submittal_attachments by file_sha256) against the
// truth-set I previously reported (group submittals.file_sha256). Then
// for every cluster, dumps storage_path / submittal_id / source /
// is_current / project so we can see exactly what each "duplicate" is.
//
// NEVER modifies a row. NEVER touches storage.

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error("Missing SUPABASE_DB_URL — apply migration first.")
  process.exit(1)
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
})
await client.connect()

// ─── 1. Attachment-level cluster truth ────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════")
console.log("Attachment-level clusters (submittal_attachments grouped by hash)")
console.log("══════════════════════════════════════════════════════════════════════")
const attClusters = await client.query(`
  SELECT
    sa.file_sha256,
    sa.company_id,
    COUNT(*) AS row_count,
    COUNT(DISTINCT sa.submittal_id) AS distinct_submittal_ids,
    COUNT(DISTINCT s.project_id) AS distinct_projects,
    BOOL_OR(s.source = 'spec_ingestion') AS has_spec_ingestion,
    ARRAY_AGG(DISTINCT s.source ORDER BY s.source) AS sources
  FROM submittal_attachments sa
  JOIN submittals s ON s.id = sa.submittal_id AND s.status <> 'deleted'
  WHERE sa.file_sha256 IS NOT NULL
  GROUP BY sa.file_sha256, sa.company_id
  HAVING COUNT(*) >= 2
  ORDER BY row_count DESC
`)
console.log(`Found ${attClusters.rows.length} attachment-level clusters.\n`)
for (const c of attClusters.rows) {
  console.log(
    `  hash ${c.file_sha256.slice(0, 12)}…  ${c.row_count} attachment rows  ` +
    `(${c.distinct_submittal_ids} submittals across ${c.distinct_projects} projects)  ` +
    `sources: ${c.sources.join("/")}` +
    (c.has_spec_ingestion ? "  [includes spec_ingestion]" : "")
  )
}

// ─── 2. Submittal-level cluster truth (what my report saw) ───────────
console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("Submittal-level clusters (submittals.file_sha256 grouped — my report)")
console.log("══════════════════════════════════════════════════════════════════════")
const subClusters = await client.query(`
  SELECT
    file_sha256, company_id, COUNT(*) AS row_count,
    COUNT(DISTINCT project_id) AS distinct_projects,
    ARRAY_AGG(DISTINCT source ORDER BY source) AS sources
  FROM submittals
  WHERE file_sha256 IS NOT NULL AND status <> 'deleted'
  GROUP BY file_sha256, company_id
  HAVING COUNT(*) >= 2
  ORDER BY row_count DESC
`)
console.log(`Found ${subClusters.rows.length} submittal-level clusters.`)
for (const c of subClusters.rows) {
  console.log(
    `  hash ${c.file_sha256.slice(0, 12)}…  ${c.row_count} submittal rows  ` +
    `${c.distinct_projects} projects  sources: ${c.sources.join("/")}`
  )
}

// ─── 3. WHY do they differ?  Per-attachment breakdown for each
//        attachment-level cluster that didn't show on the submittal view.
console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("Why the attachment-level count > submittal-level count:")
console.log("══════════════════════════════════════════════════════════════════════")
const attHashes = new Set(attClusters.rows.map(r => r.file_sha256))
const subHashes = new Set(subClusters.rows.map(r => r.file_sha256))
const onlyInAttachments = Array.from(attHashes).filter(h => !subHashes.has(h))
console.log(`Hashes appearing in attachment clusters but NOT in submittal clusters: ${onlyInAttachments.length}`)
if (onlyInAttachments.length > 0) {
  // For each such hash, show why — likely multiple attachments per submittal
  // (same hash on R0 + R1 etc., or staging+uploads if a row exists).
  for (const h of onlyInAttachments.slice(0, 5)) {
    const { rows } = await client.query(`
      SELECT sa.id, sa.submittal_id, sa.is_current, sa.storage_path, sa.revision_label,
             s.submittal_seq, s.source, s.project_id, s.file_sha256 AS parent_sha
      FROM submittal_attachments sa
      JOIN submittals s ON s.id = sa.submittal_id
      WHERE sa.file_sha256 = $1
      ORDER BY sa.submittal_id, sa.is_current DESC
    `, [h])
    console.log(`\n  hash ${h.slice(0, 12)}…  (${rows.length} attachment rows)`)
    for (const r of rows) {
      console.log(`    submittal=${r.submittal_id.slice(0, 8)} seq=${r.submittal_seq ?? "—"} src=${r.source} cur=${r.is_current} rev=${r.revision_label}`)
      console.log(`      path: ${r.storage_path}`)
      console.log(`      parent.file_sha256: ${r.parent_sha ? r.parent_sha.slice(0, 12) + "…" : "NULL"}`)
    }
  }
}

// ─── 4. Per-cluster deep dump (for ALL attachment clusters) ──────────
console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("FULL per-cluster dump (attachment level — every row)")
console.log("══════════════════════════════════════════════════════════════════════")
const projectMap = new Map()
const pj = await client.query(`SELECT id, name FROM projects`)
for (const r of pj.rows) projectMap.set(r.id, r.name)

for (const cluster of attClusters.rows) {
  console.log(`\n── hash ${cluster.file_sha256.slice(0, 16)}…  ${cluster.row_count} rows ──`)
  const { rows } = await client.query(`
    SELECT sa.id AS att_id, sa.submittal_id, sa.is_current, sa.storage_path,
           sa.revision_label, sa.uploaded_at,
           s.submittal_seq, s.submittal_number, s.source, s.project_id, s.file_name AS sub_name,
           s.received_at AS sub_received_at, s.created_at AS sub_created_at
    FROM submittal_attachments sa
    JOIN submittals s ON s.id = sa.submittal_id AND s.status <> 'deleted'
    WHERE sa.file_sha256 = $1
    ORDER BY s.project_id NULLS LAST, sa.submittal_id, sa.is_current DESC
  `, [cluster.file_sha256])
  for (const r of rows) {
    const proj = r.project_id ? (projectMap.get(r.project_id) ?? r.project_id.slice(0, 8)) : "(no project)"
    const created = (r.sub_received_at ?? r.sub_created_at)?.toISOString?.().slice(0, 10) ?? "—"
    const subRef = r.submittal_seq != null ? `Sub ${r.submittal_seq}` : (r.submittal_number ?? "")
    console.log(`  ${proj} · ${subRef}${r.revision_label ? ` (${r.revision_label})` : ""} · ${r.source} · ${created}`)
    console.log(`    submittal_id  ${r.submittal_id}`)
    console.log(`    attachment_id ${r.att_id}  is_current=${r.is_current}`)
    console.log(`    storage_path  ${r.storage_path}`)
    console.log(`    sub.file_name ${r.sub_name}`)
  }
}

// ─── 5. Storage-orphan scan for the spec_ingestion suspects.
//        For every spec_ingestion attachment row, check if a same-bytes
//        object exists in {company}/bulk-import-staging/ that no row
//        references. (We can't list storage from raw pg, so we instead
//        check: does the row's own storage_path live under uploads/?
//        and is there ANOTHER attachment with the same hash whose path
//        is under staging/?)
console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("Storage-path classification (uploads/ vs bulk-import-staging/)")
console.log("══════════════════════════════════════════════════════════════════════")
const classification = await client.query(`
  SELECT
    SUM(CASE WHEN sa.storage_path LIKE '%/bulk-import-staging/%' THEN 1 ELSE 0 END) AS staging_rows,
    SUM(CASE WHEN sa.storage_path LIKE '%/uploads/%' THEN 1 ELSE 0 END) AS uploads_rows,
    SUM(CASE WHEN sa.storage_path NOT LIKE '%/bulk-import-staging/%'
              AND sa.storage_path NOT LIKE '%/uploads/%'  THEN 1 ELSE 0 END) AS other_rows,
    COUNT(*) AS total
  FROM submittal_attachments sa
  JOIN submittals s ON s.id = sa.submittal_id AND s.status <> 'deleted'
`)
console.log(`  total attachments: ${classification.rows[0].total}`)
console.log(`  under uploads/   : ${classification.rows[0].uploads_rows}`)
console.log(`  under bulk-import-staging/: ${classification.rows[0].staging_rows}`)
console.log(`  other            : ${classification.rows[0].other_rows}`)

// Final guard: confirm no attachment row points at bulk-import-staging
// AND simultaneously shares a hash with an uploads/ row.
const stagingDoubles = await client.query(`
  WITH paths AS (
    SELECT sa.id, sa.submittal_id, sa.file_sha256, sa.storage_path,
           CASE
             WHEN sa.storage_path LIKE '%/bulk-import-staging/%' THEN 'staging'
             WHEN sa.storage_path LIKE '%/uploads/%'             THEN 'uploads'
             ELSE 'other'
           END AS bucket
    FROM submittal_attachments sa
    JOIN submittals s ON s.id = sa.submittal_id AND s.status <> 'deleted'
    WHERE sa.file_sha256 IS NOT NULL
  )
  SELECT p1.id AS staging_att_id, p1.submittal_id AS staging_sid, p1.storage_path AS staging_path,
         p2.id AS uploads_att_id, p2.submittal_id AS uploads_sid, p2.storage_path AS uploads_path,
         p1.file_sha256
  FROM paths p1
  JOIN paths p2 ON p2.file_sha256 = p1.file_sha256 AND p2.id <> p1.id
  WHERE p1.bucket = 'staging' AND p2.bucket = 'uploads'
  ORDER BY p1.file_sha256
`)
console.log(`\n  Attachment-row pairs where one points at staging/ and another at uploads/ ` +
  `(same hash): ${stagingDoubles.rows.length}`)
for (const r of stagingDoubles.rows.slice(0, 10)) {
  console.log(`    hash ${r.file_sha256.slice(0, 12)}…`)
  console.log(`      staging att: ${r.staging_path}`)
  console.log(`      uploads att: ${r.uploads_path}`)
}

await client.end()
