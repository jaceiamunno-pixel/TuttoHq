// Backfill submittals.file_name with the shared title normalizer.
//
// USAGE — dry run first, always:
//   node scripts/backfill-submittal-titles.mjs --dry-run         (default)
//   node scripts/backfill-submittal-titles.mjs --apply           (after review)
//
// Env vars required (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Tenant scoping: --company <UUID> restricts to a single company_id. Default
// is tenant-wide because the normalizer is deterministic.
//
// Behaviour:
//   - SELECTs id, file_name, company_id from submittals WHERE status='active'
//   - Computes normalizeSubmittalTitle(file_name) === new title for each row
//   - Reports: rows scanned, rows unchanged, rows that WOULD change, with
//     a per-row before/after diff, grouped by kind.
//   - In --apply mode only: issues per-row UPDATE statements. Each update is
//     independent; partial failure leaves earlier successful rows updated,
//     which is safe because re-running the script is idempotent.
//
// Idempotency: normalizeSubmittalTitle is pure; running the script twice is a
// no-op. The script never deletes rows, never touches schema, only writes the
// `file_name` column.
//
// IMPORTANT: This script's normalizer is a copy of src/lib/title-normalize.ts
// kept inline so the script runs as plain ESM without a build step. Keep the
// two in sync if the source helper changes. The stored value is NOT truncated
// — the display cap lives in the render layer.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

// ─── Inline copy of the normalizer (no truncation in the stored value) ──────

const PRESERVED_ACRONYMS = new Set([
  "O&M", "MSDS", "SDS", "QA", "QC", "QA/QC",
  "HVAC", "VAV", "RTU", "AHU", "FCU", "VRF", "VFD", "BMS", "BAS",
  "PVC", "CPVC", "ABS", "HDPE", "PEX", "EPDM", "TPO", "PTFE", "ETFE",
  "GFRC", "FRP", "EIFS", "CMU", "RCP", "GWB", "MDF", "OSB",
  "AFF", "OFCI", "OFOI", "GC", "CM", "AOR", "EOR", "MEP", "FP", "AV",
  "VIF", "TYP", "NIC", "UNO",
  "ASTM", "ASHRAE", "ANSI", "NFPA", "OSHA", "EPA", "DOE", "FDA",
  "ICC", "ICC-ES", "UL", "ULC", "ACI", "AISC", "AISI", "AWS",
  "AWWA", "AWI", "ISO", "IEEE", "NEC", "NEMA", "ATC",
  "AAMA", "FGMA", "NACE", "SSPC", "USGBC", "CSI",
  "GFI", "GFCI", "AFCI", "UPS", "ATS", "EPO", "LED", "MCC", "PDU",
  "SBS", "APP", "PMR", "IRMA",
  "USA", "US", "UK", "NYC", "LEED", "ADA", "DEP",
])
const LOWERCASE_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "if", "in", "nor",
  "of", "on", "or", "per", "the", "to", "via", "vs", "with",
])

function stripOuterQuotes(s) {
  let out = s
  for (let i = 0; i < 3; i++) {
    const before = out
    out = out.replace(/^["'‘’“”«»]+|["'‘’“”«»]+$/g, "").trim()
    if (out === before) break
  }
  return out
}
function stripOrphanedDoubleQuotes(s) {
  // Preserve inch marks (a double quote immediately following a digit, e.g.
  // 25", 3/4", 96-102"). Strip only non-inch double quotes when their count
  // is odd (at least one is unbalanced).
  const nonInchIndices = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '"' && ch !== '“' && ch !== '”') continue
    const prev = i > 0 ? s[i - 1] : ''
    if (/[0-9]/.test(prev)) continue
    nonInchIndices.push(i)
  }
  if (nonInchIndices.length % 2 === 0) return s
  const drop = new Set(nonInchIndices)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (!drop.has(i)) out += s[i]
  }
  return out
}
function titleCaseWord(word) {
  if (word.length === 0) return word
  const upper = word.toUpperCase()
  if (PRESERVED_ACRONYMS.has(upper)) return upper
  if (word.includes("-")) return word.split("-").map(titleCaseWord).join("-")
  if (word.includes("/")) return word.split("/").map(titleCaseWord).join("/")
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}
function isAllCaps(s) { return /[A-Z]/.test(s) && !/[a-z]/.test(s) }
function toTitleCase(s) {
  const words = s.split(/(\s+)/)
  let firstWordSeen = false
  return words.map(token => {
    if (/^\s+$/.test(token)) return token
    if (token.length === 0) return token
    const cased = titleCaseWord(token)
    if (!firstWordSeen) { firstWordSeen = true; return cased }
    if (LOWERCASE_WORDS.has(token.toLowerCase())) return token.toLowerCase()
    return cased
  }).join("")
}

function normalizeSubmittalTitle(raw) {
  if (raw == null) return ""
  let s = raw.trim()
  if (s.length === 0) return ""
  s = stripOuterQuotes(s)
  if (s.length === 0) return ""
  s = stripOrphanedDoubleQuotes(s)
  if (isAllCaps(s)) s = toTitleCase(s)
  return s
}

// ─── .env.local loader ──────────────────────────────────────────────────────
function loadEnvLocal() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const envPath = resolve(here, "..", ".env.local")
    const text = readFileSync(envPath, "utf-8")
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const [, k, v] = m
      if (process.env[k] == null) process.env[k] = v.replace(/^['"]|['"]$/g, "")
    }
  } catch {
    // No .env.local; caller may have set vars another way.
  }
}

// ─── Diff classifier (display purposes only) ────────────────────────────────
// Tags are independent — a row can be quote-stripped AND case-normalized, etc.
// Truncation is intentionally absent because the stored value is never
// shortened.
function classifyChange(before, after) {
  if (before === after) return "unchanged"
  const tags = []
  const beforeQuoteStripped = before.replace(/^["'‘’“”«»]+|["'‘’“”«»]+$/g, "")
  if (beforeQuoteStripped !== before) tags.push("outer-quote-stripped")
  // Use the same non-inch counting as the normalizer.
  let nonInchCount = 0
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]
    if (ch !== '"' && ch !== '“' && ch !== '”') continue
    const prev = i > 0 ? before[i - 1] : ''
    if (!/[0-9]/.test(prev)) nonInchCount++
  }
  if (nonInchCount % 2 === 1) tags.push("orphan-quote-stripped")
  if (/[A-Z]/.test(before) && !/[a-z]/.test(before)) tags.push("case-normalized")
  if (before.trim() !== before) tags.push("trimmed")
  return tags.length === 0 ? "other" : tags.join("+")
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  loadEnvLocal()
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const dryRun = !apply
  const companyIdx = args.indexOf("--company")
  const companyId = companyIdx >= 0 ? args[companyIdx + 1] : null

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.")
    process.exit(1)
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // Skip rows whose title was manually set by a user — title_locked guards
  // human edits against any automated rewrite.
  let q = supabase.from("submittals")
    .select("id, file_name, company_id, title_locked")
    .eq("status", "active")
    .eq("title_locked", false)
    .order("created_at", { ascending: true })
  if (companyId) q = q.eq("company_id", companyId)

  const { data, error } = await q
  if (error) {
    console.error("SELECT failed:", error.message)
    process.exit(1)
  }
  const rows = data ?? []

  const changes = []
  const buckets = new Map()
  let lossyRows = 0  // sanity check: should always stay 0 since truncation is gone
  for (const r of rows) {
    const before = r.file_name ?? ""
    const after = normalizeSubmittalTitle(before)
    const kind = classifyChange(before, after)
    buckets.set(kind, (buckets.get(kind) ?? 0) + 1)
    if (before !== after && after.length > 0) {
      // Defense-in-depth check — if the normalized value is shorter than the
      // original by more than the combined trim/quote/case deltas could
      // explain, something is dropping content. Flag it.
      const expectedLossUpperBound =
        (before.length - before.trim().length) +
        (before.match(/["'‘’“”«»]/g)?.length ?? 0)
      if (before.length - after.length > expectedLossUpperBound) lossyRows++
      changes.push({ id: r.id, company_id: r.company_id, before, after, kind })
    }
  }

  console.log("=== Backfill report ===")
  console.log("Mode:", dryRun ? "DRY RUN (no writes)" : "APPLY")
  console.log("Tenant scope:", companyId ?? "ALL")
  console.log("Rows scanned:", rows.length)
  console.log("Rows that would change:", changes.length)
  console.log("Lossy-truncation rows:", lossyRows, "(must be 0 — truncation is disabled)")
  console.log("Breakdown by kind:")
  for (const [kind, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${n}`)
  }
  console.log("")
  console.log("=== Per-row diff ===")
  for (const c of changes) {
    console.log(`[${c.kind}] ${c.id}`)
    console.log(`  before: ${JSON.stringify(c.before)}`)
    console.log(`  after : ${JSON.stringify(c.after)}`)
  }

  if (dryRun) {
    console.log("")
    console.log("DRY RUN complete. No writes were made. Re-run with --apply to commit.")
    return
  }

  // ── APPLY mode ──
  let ok = 0
  let fail = 0
  for (const c of changes) {
    const { error: updErr } = await supabase
      .from("submittals")
      .update({ file_name: c.after })
      .eq("id", c.id)
    if (updErr) {
      console.error(`UPDATE failed for ${c.id}:`, updErr.message)
      fail++
    } else {
      ok++
    }
  }
  console.log("")
  console.log("=== Apply complete ===")
  console.log("Updated:", ok)
  console.log("Failed: ", fail)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
