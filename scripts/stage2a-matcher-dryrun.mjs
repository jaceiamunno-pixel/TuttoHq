// READ-ONLY validation of the Stage 2a matcher against the Waters batch.
//
// Feeds each known/inferred Waters submittal section+type into the same
// match logic the route runs (mirrored here so we don't need to spin up a
// Next.js server) and reports the auto-match / ambiguous / no-match split.
// No writes; no AI; pure SQL.
//
// The actual matcher implementation lives in src/lib/bulk-import-match.ts.
// Keep this script in sync if the matcher rules change.

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Inline copy of matchSubmittalRow (keep in sync with src/lib/bulk-import-match.ts).
const STOPWORDS = new Set(["the","and","for","with","from","sub","rev","sample","inst","spi","swp","selec","r1","r2","r3","ii","iii","iv","v"])
function tokenize(s) {
  if (!s) return new Set()
  return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t)))
}
function fuzz(a, b) {
  const ta = tokenize(a), tb = tokenize(b)
  let n = 0
  for (const t of ta) if (tb.has(t)) n += 1
  return n
}
async function matchRow(supa, { project_id, section, submittal_type, description }) {
  if (!section || !submittal_type) {
    return { kind: "no-match", reason: "section-or-type-missing" }
  }
  const { data: cands, error } = await supa
    .from("submittals")
    .select("id, csi_section, submittal_type, submittal_seq, material_name, spec_section_id")
    .eq("project_id", project_id)
    .eq("source", "spec_ingestion")
    .eq("csi_section", section)
    .eq("submittal_type", submittal_type)
    .neq("status", "deleted")
  if (error) return { kind: "error", message: error.message }
  if (!cands || cands.length === 0) return { kind: "no-match", reason: "no-spec-row-for-section-type" }
  if (cands.length === 1) return { kind: "auto-match", targetRowId: cands[0].id, target: cands[0] }
  const names = cands.map(c => (c.material_name ?? "").toUpperCase().trim())
  const distinctNames = new Set(names.filter(Boolean))
  if (distinctNames.size <= 1) {
    const sorted = [...cands].sort((x, y) => (x.submittal_seq ?? Infinity) - (y.submittal_seq ?? Infinity))
    return { kind: "auto-match", targetRowId: sorted[0].id, target: sorted[0], duplicateCount: cands.length }
  }
  const ranked = cands.map(c => ({ ...c, fuzzyScore: fuzz(description, c.material_name) }))
                      .sort((x, y) => y.fuzzyScore - x.fuzzyScore)
  return { kind: "ambiguous-distinct", candidates: ranked, defaultRowId: ranked[0].id }
}

// Waters target project (sections include 09 31 00 from prior analysis).
const projectId = "350ee2a5-49e4-4675-9826-ada407a53d3d"

// The Waters batch: best-known section + type per submittal, from prior
// sessions. Extractor-confirmed entries are marked. The rest are CSI-
// inference from the filename description — these would be the user's
// confirmed values in the modal.
const WATERS_BATCH = [
  // sub#       section         type             description                            note
  { sub:"030", section:"08 11 13", type:"Shop Drawing", description:"Frame and Door Schedule" },
  { sub:"031", section:"08 71 00", type:"Shop Drawing", description:"Hardware Schedule" },
  { sub:"032", section:"09 51 23", type:"Product Data", description:"Acoustical Tile Ceilings" },
  { sub:"033", section:"09 84 33", type:"Sample",       description:"Sound Absorbing Wall Units" },
  { sub:"071", section:"10 21 13", type:"Product Data", description:"Toilet Partitions and Accessories" },
  { sub:"075", section:"04 22 00", type:"Product Data", description:"Masonry Package" },
  { sub:"077", section:"09 65 13", type:"Product Data", description:"Flooring" },
  { sub:"078", section:"09 65 13", type:"Product Data", description:"Resilient Base and Accessories" },
  { sub:"079", section:"09 31 00", type:"Sample",       description:"Ceramic Tile", note:"extractor-confirmed 09 31 00" },
  { sub:"080", section:"09 68 13", type:"Product Data", description:"Tile Carpeting", note:"extractor-confirmed 09 68 13" },
  { sub:"118", section:"07 21 00", type:"Product Data", description:"Wall Insulation", note:"extractor-confirmed 07 21 00" },
  { sub:"146", section:"10 51 13", type:"Product Data", description:"Metal Lockers" },
  { sub:"147", section:"09 22 16", type:"Product Data", description:"Non-Structural Metal Framing", note:"extractor-confirmed 09 22 16" },
  { sub:"158", section:"09 67 23", type:"Sample",       description:"Flooring Sample", note:"extractor primary 09 67 23 + sibling 09 65 19" },
  { sub:"159", section:"09 67 23", type:"Sample",       description:"Flooring Sample II" },
  { sub:"160", section:"09 51 23", type:"Sample",       description:"Acoustical Tile and Grid Sample 1" },
  { sub:"203", section:"08 33 13", type:"Shop Drawing", description:"Coiling Counter Doors" },
  { sub:"234", section:"09 31 00", type:"Sample",       description:"Ceramic Tile Sample" },
  { sub:"260", section:"10 51 13", type:"Product Data", description:"SWP Inst Lockers" },
  { sub:"261", section:"04 22 00", type:"Product Data", description:"SWP Inst Masonry" },
  { sub:"262", section:"02 41 13", type:"Product Data", description:"SWP Selective Demolition" },
  { sub:"287", section:"32 31 13", type:"Product Data", description:"SWP Inst Wind Screen", note:"section uncertain" },
  { sub:"289", section:"09 65 13", type:"Product Data", description:"SWP Inst Flooring" },
  { sub:"361", section:"08 33 13", type:"Product Data", description:"SWP Inst Coiling Counter Doors" },
  { sub:"364", section:"09 31 00", type:"Sample",       description:"Ceramic Tile Sample CT3" },
  { sub:"370", section:"09 67 23", type:"Sample",       description:"Flooring Sample III" },
]

console.log("Running Stage 2a matcher dry-run against Waters batch (" + WATERS_BATCH.length + " submittals)")
console.log("Target project: " + projectId + "\n")

const buckets = { autoMatch: [], autoMatchDup: [], ambiguous: [], noMatchMissing: [], noMatchEmpty: [], error: [] }

for (const b of WATERS_BATCH) {
  const outcome = await matchRow(a, {
    project_id: projectId,
    section: b.section,
    submittal_type: b.type,
    description: b.description,
  })
  const prefix = "Sub#" + b.sub.padStart(3, "0") + "  " + b.section + "  " + b.type.padEnd(13) + "  " + b.description.padEnd(40).slice(0, 40)
  if (outcome.kind === "auto-match") {
    if (outcome.duplicateCount && outcome.duplicateCount > 1) {
      console.log("  AUTO-MATCH (dup x" + outcome.duplicateCount + ")  " + prefix + " → " + (outcome.target?.material_name ?? "?") + " (seq " + outcome.target?.submittal_seq + ")")
      buckets.autoMatchDup.push({ ...b, outcome })
    } else {
      console.log("  AUTO-MATCH              " + prefix + " → " + (outcome.target?.material_name ?? "?") + " (seq " + outcome.target?.submittal_seq + ")")
      buckets.autoMatch.push({ ...b, outcome })
    }
  } else if (outcome.kind === "ambiguous-distinct") {
    console.log("  AMBIGUOUS (" + outcome.candidates.length + ")          " + prefix + " → best: " + (outcome.candidates[0]?.material_name ?? "?") + " (fuzzy=" + outcome.candidates[0]?.fuzzyScore + ")")
    buckets.ambiguous.push({ ...b, outcome })
  } else if (outcome.kind === "no-match") {
    if (outcome.reason === "section-or-type-missing") {
      console.log("  NO-MATCH (empty)        " + prefix)
      buckets.noMatchEmpty.push({ ...b, outcome })
    } else {
      console.log("  NO-MATCH (sec absent)   " + prefix + (b.note ? "  — " + b.note : ""))
      buckets.noMatchMissing.push({ ...b, outcome })
    }
  } else {
    console.log("  ERROR                   " + prefix + "  " + outcome.message)
    buckets.error.push({ ...b, outcome })
  }
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
console.log("SUMMARY:")
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
console.log("  Auto-match (single candidate):       " + buckets.autoMatch.length + " / " + WATERS_BATCH.length)
console.log("  Auto-match (collapsed parser dupes): " + buckets.autoMatchDup.length)
console.log("  Ambiguous (distinct names — pick):   " + buckets.ambiguous.length)
console.log("  No-match (section not in spec book): " + buckets.noMatchMissing.length)
console.log("  No-match (section or type empty):    " + buckets.noMatchEmpty.length)
console.log("  Matcher errors:                      " + buckets.error.length)

const matchable = buckets.autoMatch.length + buckets.autoMatchDup.length + buckets.ambiguous.length
const total = WATERS_BATCH.length
console.log("\n  Matchable rate:                      " + matchable + " / " + total + " (" + ((matchable / total) * 100).toFixed(0) + "%)")
console.log("  No-match rate:                       " + (buckets.noMatchMissing.length + buckets.noMatchEmpty.length) + " / " + total + " (" + (((buckets.noMatchMissing.length + buckets.noMatchEmpty.length) / total) * 100).toFixed(0) + "%)")

if (buckets.noMatchMissing.length > 0) {
  console.log("\n  No-match rows (would block commit until user picks an existing log row or skips):")
  for (const r of buckets.noMatchMissing) console.log("    Sub#" + r.sub + "  " + r.section + "  " + r.type + "  — " + r.description)
}
if (buckets.ambiguous.length > 0) {
  console.log("\n  Ambiguous rows (would require a user pick before commit):")
  for (const r of buckets.ambiguous) {
    console.log("    Sub#" + r.sub + "  " + r.section + "  " + r.type + "  — " + r.description)
    for (const c of r.outcome.candidates.slice(0, 4)) console.log("       candidate: " + c.material_name + " (seq " + c.submittal_seq + ", fuzzy=" + c.fuzzyScore + ")")
  }
}
