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
//   no_body       — in scope, but no spec_sections row exists for it: the
//                   section's body was never parsed. Almost always a MISSING
//                   VOLUME, not a parser miss.
//   body_no_items — the body parsed (a spec_sections row exists) but no
//                   submittal items were extracted from it. A CONTENT gap.
//
// The two are deliberately never collapsed: the first sends the user to hunt
// for a missing document, the second to look at the section's content.
export type ScopeDiagnosis = "no_body" | "body_no_items"

// Full sentence — the inline flag on the scope row (the primary surface).
export const SCOPE_DIAGNOSIS_MESSAGE: Record<ScopeDiagnosis, string> = {
  no_body:
    "No parsed spec content — this section wasn't found in the uploaded volume(s). Check whether its spec book volume is missing.",
  body_no_items:
    "Spec parsed, but no submittal items were found in this section.",
}

// Compact label for dense lists (the spec-books flagged-section list).
export const SCOPE_DIAGNOSIS_LABEL: Record<ScopeDiagnosis, string> = {
  no_body: "no spec body found",
  body_no_items: "no submittal items",
}
