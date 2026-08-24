// Shared, runtime-free types for spec-book TOC parsing and project scope.
// Pure types only — safe to import from both server (unpdf) and client code.

export interface TocEntry {
  specNumber: string    // normalized "03 30 00"
  specTitle: string     // "Cast-in-Place Concrete"
  divisionCode: string  // "03"
}

export interface TocDivision {
  code: string          // "03"
  name: string          // "Concrete"
  sectionCount: number
}

// ─── Scope diagnosis ─────────────────────────────────────────────────────────
//
// Computed by GET /api/projects/[id]/scope for each in-scope section, AFTER a
// spec book has been parsed. It explains why a scoped section produced nothing
// in the submittal log — the silent case the log itself can never surface,
// because generation is staged-driven (scope only ever SUBTRACTS staged rows,
// it never generates from scope). Joined on spec_number, the reparse-stable
// key — spec_section_id is nulled ON DELETE SET NULL, so the FK cannot be used.
//
//   no_body           — in scope, but no spec_sections row exists for it: the
//                       section's body was never parsed. Almost always a
//                       MISSING VOLUME, not a parser miss.
//   extraction_failed — the body parsed, but the AI itemization lost at least
//                       one chunk (truncated / unparseable response), so its
//                       staged rows are INCOMPLETE. Sourced from
//                       parse_summary.failedSections. Must never read as "no
//                       submittals" — the section needs a manual review.
//   body_no_items     — the body parsed (a spec_sections row exists) but no
//                       submittal items were extracted from it. A CONTENT gap.
//
// These are deliberately never collapsed: the first sends the user to hunt
// for a missing document, the second to re-run/review the section, the third
// to look at the section's content.
export type ScopeDiagnosis = "no_body" | "extraction_failed" | "body_no_items"

// Full sentence — the inline flag on the scope row (the primary surface).
export const SCOPE_DIAGNOSIS_MESSAGE: Record<ScopeDiagnosis, string> = {
  no_body:
    "No parsed spec content — this section wasn't found in the uploaded volume(s). Check whether its spec book volume is missing.",
  extraction_failed:
    "Submittal extraction did not complete for this section — its items are missing or incomplete. Review this section's spec manually.",
  body_no_items:
    "Spec parsed, but no submittal items were found in this section.",
}

// Compact label for dense lists (the spec-books flagged-section list).
export const SCOPE_DIAGNOSIS_LABEL: Record<ScopeDiagnosis, string> = {
  no_body: "no spec body found",
  extraction_failed: "extraction incomplete — review manually",
  body_no_items: "no submittal items",
}
