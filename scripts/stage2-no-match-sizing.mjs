// READ-ONLY sizing for the Stage 2 "no-match" UX problem.
//
// The Waters batch staging PDFs were deleted in the 2026-06-03 cleanup,
// so we can't re-run the section extractor against them. We can still
// answer the strategic question from preserved data:
//
//   - Audit JSON (scripts/staging-cleanup-candidates.json) keeps the
//     filenames — which carry the Waters submittal# AND a free-text
//     description (e.g. "0301-0509_Sub_No_080_Tile_Carpeting.pdf").
//   - The Waters target project's spec_ingestion rows carry section,
//     type, and material_name.
//
// Proxy match: tokenize each Waters filename's description, score
// token-overlap against every spec-book material_name in the target
// project, and bucket as strong/weak/none. This isn't section-equality
// (which is what real Stage 2 matching would do) — it's a rough proxy
// for "does the spec book have something semantically near this
// submittal?" Bigger picture: even if the section recovery succeeded,
// no-match is determined by whether the spec book even has the section.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// 1) Pull every spec_ingestion row for the company.
const { data: allRows, error } = await a
  .from("submittals")
  .select("project_id, csi_section, csi_division, material_name, submittal_type, source")
  .eq("company_id", "c7c08273-8d0a-40fd-8f67-b712955eeb47")
  .eq("source", "spec_ingestion")
  .neq("status", "deleted")
if (error) { console.error("query error:", error.message); process.exit(1) }

const byProject = {}
for (const r of allRows) {
  const p = (byProject[r.project_id] ??= { rows: 0, sections: new Set(), divisions: new Set(), names: new Set() })
  p.rows += 1
  if (r.csi_section)  p.sections.add(r.csi_section)
  if (r.csi_division) p.divisions.add(r.csi_division)
  if (r.material_name) p.names.add(r.material_name.toUpperCase())
}

console.log("Per-project spec-book coverage:")
for (const [pid, v] of Object.entries(byProject)) {
  console.log("  " + pid.slice(0,8) + " — rows: " + String(v.rows).padStart(3) +
              "  distinct sections: " + String(v.sections.size).padStart(3) +
              "  distinct divisions: " + String(v.divisions.size).padStart(2))
}

// 2) Pick the Waters target project — the one with section "09 31 00" populated
//    (where Sub 079 "Ceramic Tile" matched 3 rows earlier in our analysis).
let targetProjectId = null
for (const [pid, v] of Object.entries(byProject)) {
  if (v.sections.has("09 31 00")) { targetProjectId = pid; break }
}
if (!targetProjectId) {
  console.error("Could not auto-identify Waters target project (no project carries '09 31 00').")
  process.exit(1)
}
console.log("\nWaters target project: " + targetProjectId + " (" + byProject[targetProjectId].rows + " rows, " + byProject[targetProjectId].sections.size + " sections)")

// 3) Load the audit list of staged files (deleted, but their filenames are preserved).
const audit = JSON.parse(readFileSync("scripts/staging-cleanup-candidates.json", "utf-8"))

// Filter to the Waters batch files: filename pattern '0301-0509_Sub_No_NNN_...'.
const FN_RE = /0301-0509[_-]?Sub[_-]?No[_-]?(\d{3})([-_]R\d+)?[_-]?(.*?)(?:\.pdf)?$/i
const batchAll = audit.candidates
  .map(c => ({ ...c, basename: c.path.split("/").pop() }))
  .map(c => {
    const stripped = c.basename.replace(/^[0-9a-f-]{36}_/, "")
    const m = stripped.match(FN_RE)
    if (!m) return null
    return {
      basename: c.basename,
      subNum: m[1],
      rev: m[2] ? m[2].replace(/[_-]/g, "") : null,
      description: (m[3] || "").replace(/[_-]+/g, " ").trim(),
    }
  })
  .filter(Boolean)

// Dedup by submittal# (R2/R3 are revisions of one submittal — count once).
const dedupedMap = new Map()
for (const b of batchAll) {
  if (!dedupedMap.has(b.subNum)) dedupedMap.set(b.subNum, b)
}
const batch = [...dedupedMap.values()].sort((a, b) => parseInt(a.subNum) - parseInt(b.subNum))

console.log("\nWaters batch — " + batch.length + " unique submittal numbers (from " + batchAll.length + " staged objects, deduping revisions):")

// 4) Token-overlap match for each batch file against material_name on the target project.
const STOPWORDS = new Set(["the","and","for","with","from","sub","no","rev","sample","ii","iii","iv","v","inst","spi","swp","selec","r1","r2","r3"])
function tokens(s) {
  return new Set((s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t)))
}
const targetCandidates = allRows
  .filter(r => r.project_id === targetProjectId && r.material_name)
  .map(r => ({
    section: r.csi_section,
    type: r.submittal_type,
    name: r.material_name,
    tokens: tokens(r.material_name),
  }))

function score(descTokens, targetTokens) {
  let n = 0
  for (const t of descTokens) if (targetTokens.has(t)) n += 1
  return n
}

const scored = batch.map(b => {
  const t = tokens(b.description)
  if (t.size === 0) return { ...b, score: 0, best: null }
  let best = null
  let bestScore = 0
  for (const c of targetCandidates) {
    const s = score(t, c.tokens)
    if (s > bestScore) { bestScore = s; best = c }
  }
  return { ...b, score: bestScore, best }
})

const strong = scored.filter(r => r.score >= 2)
const weak   = scored.filter(r => r.score === 1)
const none   = scored.filter(r => r.score === 0)

console.log("\nBuckets:")
console.log("  strong match (>=2 token overlap):  " + strong.length + " / " + batch.length)
console.log("  weak match (1 token):              " + weak.length)
console.log("  no match (0 tokens):               " + none.length)

console.log("\n━━ STRONG MATCH ━━")
for (const r of strong) {
  const lhs = "Sub#" + r.subNum + (r.rev ? "/" + r.rev : "") + "  " + (r.description || "").slice(0, 38).padEnd(40)
  const rhs = r.best ? (r.best.section + "  " + (r.best.type || "?").slice(0, 12).padEnd(13) + "— " + (r.best.name || "").slice(0, 40)) : ""
  console.log("  " + lhs + "→ " + rhs)
}
console.log("\n━━ WEAK MATCH ━━")
for (const r of weak) {
  const lhs = "Sub#" + r.subNum + (r.rev ? "/" + r.rev : "") + "  " + (r.description || "").slice(0, 38).padEnd(40)
  const rhs = r.best ? (r.best.section + "  " + (r.best.type || "?").slice(0, 12).padEnd(13) + "— " + (r.best.name || "").slice(0, 40)) : ""
  console.log("  " + lhs + "→ " + rhs)
}
console.log("\n━━ NO MATCH ━━")
for (const r of none) {
  const lhs = "Sub#" + r.subNum + (r.rev ? "/" + r.rev : "") + "  " + (r.description || "").slice(0, 38).padEnd(40)
  console.log("  " + lhs + "→ (no token overlap with any spec-book material in target project)")
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
console.log("Spec-book sections present in Waters target project " + targetProjectId.slice(0,8) + ":")
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
const tgt = byProject[targetProjectId]
console.log("Total spec-built rows:", tgt.rows)
console.log("Distinct sections: " + tgt.sections.size + "   distinct divisions: " + tgt.divisions.size)
console.log()
const secs = [...tgt.sections].filter(Boolean).sort()
for (let i = 0; i < secs.length; i += 8) {
  console.log("  " + secs.slice(i, i+8).join("   "))
}
