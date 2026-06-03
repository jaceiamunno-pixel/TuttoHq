// Bulk Import — Stage 2a matcher.
//
// Resolves an incoming reviewed-submittal row to an existing spec-book-built
// row on the submittals table. Model A: NEVER silently creates a row. The
// caller (commit route) MUST refuse to write when this returns no-match,
// and MUST block commit until ambiguous-distinct cases have a user pick.
//
// Key: (project_id, csi_section, submittal_type) on `source = 'spec_ingestion'`
// rows within the caller's project. The query uses the caller's auth so
// RLS enforces tenant isolation — an attacker passing another company's
// project_id gets an empty result set, not a cross-tenant match.
//
// Outcomes:
//   auto-match            — 1 candidate, OR 2+ candidates whose material_name
//                            is identical (spec-book parser duplicates →
//                            pick the lowest submittal_seq and proceed; do
//                            NOT burn the user's attention on parser dupes).
//   ambiguous-distinct    — 2+ candidates with DIFFERENT material_names.
//                            User must pick. We fuzzy-rank by the
//                            coversheet description so the most-likely
//                            candidate is the default.
//   no-match              — Stage 1 didn't extract a section/type OR no
//                            spec-built row matches in this project.
//                            User must pick a different row OR skip.
//                            Commit MUST refuse this row until resolved.

import type { SupabaseClient } from "@supabase/supabase-js"

export interface MatchedRow {
  id: string
  csi_section: string | null
  submittal_type: string | null
  submittal_seq: number | null
  material_name: string | null
  spec_section_id: string | null
}

export interface ScoredCandidate extends MatchedRow {
  /** Token-overlap score between the coversheet description and this
   *  candidate's material_name. Higher = better. 0 means no overlap. */
  fuzzyScore: number
}

export type MatchOutcome =
  | {
      kind: "auto-match"
      targetRowId: string
      target: MatchedRow
      /** Set when the auto-match came from collapsing identical-name
       *  spec-book duplicates. Surface for visibility but don't block. */
      duplicateCount?: number
    }
  | {
      kind: "ambiguous-distinct"
      candidates: ScoredCandidate[]
      /** Best-fuzzy-score candidate the modal defaults the picker to. The
       *  user still has to confirm (one tap) — we never silently choose. */
      defaultRowId: string
    }
  | {
      kind: "no-match"
      reason: "section-or-type-missing" | "no-spec-row-for-section-type"
    }
  | {
      kind: "error"
      message: string
    }

const STOPWORDS = new Set([
  "the","and","for","with","from","sub","rev","sample","inst","spi","swp",
  "selec","r1","r2","r3","ii","iii","iv","v",
])

function tokenize(s: string | null | undefined): Set<string> {
  if (!s) return new Set()
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && !STOPWORDS.has(t)),
  )
}

/** Token-overlap fuzzy score — cheap, deterministic, no AI. Used only to
 *  rank candidates within an ambiguous-distinct outcome; never to make a
 *  silent pick. */
function fuzzyScore(description: string | null | undefined, materialName: string | null | undefined): number {
  const a = tokenize(description)
  const b = tokenize(materialName)
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

export interface MatchArgs {
  project_id: string
  section: string | null | undefined
  submittal_type: string | null | undefined
  /** Coversheet description (Waters Text8 / BAM section title). Used only
   *  for ambiguity ranking. Optional. */
  description?: string | null
}

/**
 * Match a Bulk Import row to a spec-built submittals row.
 *
 * Read-only. No writes. Caller is responsible for gating the commit:
 *   - auto-match            → safe to commit (after user confirms approval date etc.)
 *   - ambiguous-distinct    → REQUIRES user pick before commit
 *   - no-match              → REQUIRES user reroute OR skip; commit MUST refuse
 *   - error                 → REQUIRES retry or skip; commit MUST refuse
 *
 * Tenant safety: the SELECT runs through the caller's authenticated
 * Supabase client, so the submittals table's company-scoped RLS filters
 * out cross-tenant rows before this function ever sees them. We rely on
 * that AND add an explicit `project_id` equality so a project pasted from
 * another company would still return empty (RLS strips them; this is the
 * second line of defense).
 */
export async function matchSubmittalRow(
  supabase: SupabaseClient,
  args: MatchArgs,
): Promise<MatchOutcome> {
  if (!args.section || !args.submittal_type) {
    return { kind: "no-match", reason: "section-or-type-missing" }
  }

  const { data: candidates, error } = await supabase
    .from("submittals")
    .select("id, csi_section, submittal_type, submittal_seq, material_name, spec_section_id")
    .eq("project_id", args.project_id)
    .eq("source", "spec_ingestion")
    .eq("csi_section", args.section)
    .eq("submittal_type", args.submittal_type)
    .neq("status", "deleted")

  if (error) return { kind: "error", message: error.message }
  if (!candidates || candidates.length === 0) {
    return { kind: "no-match", reason: "no-spec-row-for-section-type" }
  }
  if (candidates.length === 1) {
    return { kind: "auto-match", targetRowId: candidates[0].id, target: candidates[0] }
  }

  // 2+ candidates. Are they all the same material (parser duplicates)?
  const namesNorm = candidates.map(c => (c.material_name ?? "").toUpperCase().trim())
  const distinctNames = new Set(namesNorm.filter(Boolean))

  if (distinctNames.size <= 1) {
    // Spec-book parser duplicates — pick the lowest seq (oldest). Don't
    // ask the user; they all point at the same item.
    const sorted = [...candidates].sort(
      (a, b) => (a.submittal_seq ?? Number.POSITIVE_INFINITY) - (b.submittal_seq ?? Number.POSITIVE_INFINITY),
    )
    return {
      kind: "auto-match",
      targetRowId: sorted[0].id,
      target: sorted[0],
      duplicateCount: candidates.length,
    }
  }

  // Distinct material_names — true ambiguity. Rank by description fuzz.
  const ranked: ScoredCandidate[] = candidates
    .map(c => ({ ...c, fuzzyScore: fuzzyScore(args.description, c.material_name) }))
    .sort((a, b) => b.fuzzyScore - a.fuzzyScore)

  return {
    kind: "ambiguous-distinct",
    candidates: ranked,
    defaultRowId: ranked[0].id,
  }
}
