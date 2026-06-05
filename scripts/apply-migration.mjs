// scripts/apply-migration.mjs
//
// Apply a SQL migration file against Supabase via a direct PostgreSQL
// connection. Tries SUPABASE_DB_URL from .env.local first. If that's
// the IPv6-only `db.{ref}.supabase.co` direct hostname (which often
// can't be reached from typical Windows networks), extracts the
// password and retries through each AWS region's Session pooler.
//
// On success, normalizes .env.local: ensures the URL is stored under
// the SUPABASE_DB_URL= key in the proven-working Session-pooler form
// so re-runs don't repeat the region probe.
//
// Wraps the SQL in BEGIN/COMMIT — a partial failure rolls back cleanly.
//
// USAGE: node scripts/apply-migration.mjs sql/<file>.sql

import { readFileSync, writeFileSync } from "node:fs"
import pg from "pg"

const envText = readFileSync(".env.local", "utf-8")
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}

const sqlFile = process.argv[2]
if (!sqlFile) {
  console.error("Usage: node scripts/apply-migration.mjs <path-to-sql-file>")
  process.exit(1)
}
const sql = readFileSync(sqlFile, "utf-8")

// Find any postgresql:// line in the env file. The user may have pasted
// it bare without a key prefix; we still want to grab it.
function findPostgresUrl(text) {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL.trim()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith("postgresql://")) return trimmed
  }
  return null
}

const sourceUrl = findPostgresUrl(envText)
if (!sourceUrl) {
  console.error("No postgresql:// URL found in .env.local")
  process.exit(1)
}

// Extract project ref + password from whatever form the user provided.
//   Direct  format: postgresql://postgres:PASS@db.<ref>.supabase.co:5432/postgres
//   Pooler  format: postgresql://postgres.<ref>:PASS@aws-0-<region>.pooler.supabase.com:5432/postgres
function parseSourceUrl(url) {
  const u = new URL(url)
  // pg connection password can be URL-encoded; we keep it as-is
  const password = decodeURIComponent(u.password)
  const directRefMatch = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)
  const poolerUserMatch = u.username.match(/^postgres\.([a-z0-9]+)$/i)
  const ref = directRefMatch ? directRefMatch[1] : (poolerUserMatch ? poolerUserMatch[1] : null)
  if (!ref) throw new Error(`Cannot extract project ref from ${u.hostname}`)
  const isPooler = u.hostname.endsWith(".pooler.supabase.com")
  const knownGoodRegion = isPooler ? u.hostname.match(/^aws-0-([a-z0-9-]+)\.pooler\.supabase\.com$/)?.[1] ?? null : null
  return { ref, password, isPooler, knownGoodRegion }
}

const { ref, password, isPooler, knownGoodRegion } = parseSourceUrl(sourceUrl)

// Session-pooler URL builder. Port 5432 (NOT 6543 — that's transaction
// pooler, which can't run DDL with prepared statements). Username is
// `postgres.<ref>` for the pooler, not bare `postgres`.
function buildPoolerUrl(region) {
  // pg client accepts a plain URL; we URL-encode the password defensively
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`
}

// If the URL is already a working pooler, try it first. Otherwise probe
// the common AWS regions until one authenticates.
const REGION_PROBE = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
  "ap-south-1", "ap-east-1", "sa-east-1", "ca-central-1",
]
const POOLER_PREFIXES = ["aws-0", "aws-1"]
function buildAllCandidates() {
  const out = []
  if (isPooler && knownGoodRegion) out.push({ region: `${knownGoodRegion} (current)`, url: sourceUrl })
  for (const prefix of POOLER_PREFIXES) {
    for (const region of REGION_PROBE) {
      out.push({
        region: `${prefix}/${region}`,
        url: `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${prefix}-${region}.pooler.supabase.com:5432/postgres`,
      })
    }
  }
  return out
}
const candidates = buildAllCandidates()
void buildPoolerUrl // keep helper

let workingUrl = null
let workingRegion = null
for (const c of candidates) {
  const client = new pg.Client({
    connectionString: c.url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 7000,
  })
  process.stdout.write(`Probing region ${c.region}... `)
  try {
    await client.connect()
    await client.query("SELECT 1")
    console.log("✓ connected")
    workingUrl = c.url
    workingRegion = c.region
    await client.end()
    break
  } catch (err) {
    console.log(`✗ ${err.code ?? ""} ${err.message ?? ""}`.trim())
    await client.end().catch(() => {})
  }
}
if (!workingUrl) {
  console.error("\nCould not reach any Session pooler region. Check the password + project status.")
  process.exit(1)
}
console.log(`\nApplying ${sqlFile} via ${workingRegion} pooler (${sql.length} bytes)\n`)

const client = new pg.Client({
  connectionString: workingUrl,
  ssl: { rejectUnauthorized: false },
})

const t0 = Date.now()
await client.connect()
try {
  await client.query("BEGIN")
  await client.query(sql)
  await client.query("COMMIT")
  console.log(`✓ Migration applied in ${Date.now() - t0}ms`)
} catch (err) {
  await client.query("ROLLBACK").catch(() => {})
  console.error(`✗ Migration failed (rolled back): ${err.message}`)
  if (err.position) console.error(`  Position: ${err.position}`)
  if (err.hint)     console.error(`  Hint:     ${err.hint}`)
  if (err.detail)   console.error(`  Detail:   ${err.detail}`)
  process.exit(1)
} finally {
  await client.end()
}

// Normalize .env.local so re-runs don't re-probe.
//   - Remove any bare `postgresql://...` line the user pasted
//   - Set SUPABASE_DB_URL=<working pooler URL>
const lines = envText.split(/\r?\n/)
const cleaned = lines.filter(l => {
  const t = l.trim()
  if (t.startsWith("postgresql://")) return false
  if (t.startsWith("SUPABASE_DB_URL=")) return false
  return true
})
cleaned.push(`SUPABASE_DB_URL=${workingUrl}`)
writeFileSync(".env.local", cleaned.join("\n"), "utf-8")
console.log(`✓ .env.local normalized — SUPABASE_DB_URL set to working ${workingRegion} pooler URL`)
