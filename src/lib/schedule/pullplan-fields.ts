// ── Shared pull-plan field logic ─────────────────────────────────────────────
// Used by BOTH pull-plan importers — the PDF text-layer parser (import-parse.ts)
// and the XLSX spreadsheet parser (xlsx-parse.ts) — so the two stay in lockstep on
// how a "N DAY(S)" / "N PEOPLE" cell and a responsibility code become a BACKLOG
// task. Pure string helpers + the row finalizer; no I/O, no positional geometry.
//
// Type-only import of ProposedTaskRow (erased at runtime) — import-parse.ts value-
// imports the helpers below, so the runtime module edge is one-directional.

import type { ProposedTaskRow } from "./import-parse"

// "1 DAY", "5 DAYS" → the integer (case-insensitive). Exported because the PDF
// pull-plan path tests/extracts token-by-token against these in its positional pass.
export const PP_DUR_RE = /\b(\d+)\s*days?\b/i
export const PP_CREW_RE = /(\d+)\s*people\b/i

// A duration CELL → positive whole days, or null. Accepts "N DAY(S)" or a bare
// number cell (a spreadsheet may store 5 rather than "5 days"). Zero/negative → null:
// a backlog nominal duration must be a positive span, and the write route rejects ≤ 0.
// Used by the XLSX importer, where the cell is already isolated to its column.
export function parsePullPlanDuration(text: string | null | undefined): number | null {
  const s = (text ?? "").trim()
  if (!s) return null
  const m = s.match(PP_DUR_RE)
  if (m) { const n = Number(m[1]); return Number.isInteger(n) && n > 0 ? n : null }
  if (/^\d+(?:\.\d+)?$/.test(s)) { const n = Math.round(parseFloat(s)); return n > 0 ? n : null }
  return null
}

// A crew-size CELL → whole people (≥ 0), or null. Accepts "N PEOPLE" or a bare number.
export function parsePullPlanCrew(text: string | null | undefined): number | null {
  const s = (text ?? "").trim()
  if (!s) return null
  const m = s.match(PP_CREW_RE)
  if (m) { const n = Number(m[1]); return Number.isInteger(n) && n >= 0 ? n : null }
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 0 ? n : null }
  return null
}

// Build a BACKLOG ProposedTaskRow from pull-plan fields: undated, crew_size +
// (nominal) duration_days informational, the responsibility/title path → phase.
// Wrapped names (a PDF-only concern) are flagged needsReview so the modal nudges a
// glance; the XLSX path passes wrapped=false (one spreadsheet row = one activity).
export function finalizePullPlanRow(
  name: string,
  phase: string | null,
  duration_days: number | null,
  crew_size: number | null,
  wrapped: boolean,
): ProposedTaskRow {
  const reviewReasons: string[] = []
  if (wrapped) reviewReasons.push("Activity name wrapped across lines — confirm it didn't merge with a neighbor")
  return {
    name: name.trim(),
    start_date: null,
    end_date: null,
    duration_days,
    crew_size,
    is_milestone: false,
    phase, // responsible party/trade (optionally prefixed by the project block) → phase
    wbs_code: null,
    predecessors_raw: null,
    percent_complete: null,
    resources: null,
    actual_start_date: null,
    actual_end_date: null,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  }
}
