# ADR-005: Drawing Log v1 (Phase 1 — No Bluebeam API)

**Date:** 2026-06-08
**Status:** Accepted
**Decision driver:** Drawing Log — a project needs a versioned, searchable index of drawing sheets, with each sheet carrying its file revisions.

---

## Context

GCs manage drawing sets as monolithic multi-page PDFs and track revisions by hand. TuttoHQ needs a Drawing Log: one record per sheet (number / title / discipline), each pointing at its current file revision, with full history. Phase 1 is deliberately scoped to **exclude any Bluebeam Studio API integration** — sheets and revisions come from user-uploaded PDFs (split + titleblock extraction), with a `source` column reserved so a later `bluebeam-markup` provenance can slot in without a schema change.

Constraints at decision time:
- **Live, single-tenant data; careful lane** on storage / tenant-isolation / file-integrity.
- Must reuse established patterns: company-scoped RLS (`get_my_company_id()`), the submittals stored-generated `search_vector`, and ADR-001 Staging→Review→Commit for the AI/heuristic extraction step (the splitter).
- A sheet ↔ its current revision is a natural circular reference that the schema must resolve cleanly.

## Options considered

### Option A: Two tables — `drawing_sheets` + `drawing_revisions` (chosen)
Sheet is the stable identity; revisions are file versions under it; the sheet points at its current revision.
- Pros: Clean version history; `current_revision_id` gives O(1) "latest"; integrity columns (`file_sha256`, `file_size`, `source`) live on the revision where they belong; mirrors the firm→people parent/child shape already in the codebase.
- Cons: Circular FK to resolve; two inserts per new sheet.

### Option B: Single flat table (one row per uploaded file)
Each file row carries sheet metadata + revision label.
- Pros: No circular FK; one insert.
- Cons: No stable sheet identity across revisions; "current" and "history" become query gymnastics; duplicated sheet metadata per revision.

### Option C: Reuse `submittals` / `drawing_log`
Fold drawings into an existing table.
- Pros: No new tables.
- Cons: `submittals` semantics (review cycle, CSI) don't fit; `drawing_log` is the transmittal table (different concern). Overloading either erodes both.

## Decision

**Option A.** Two additive tables:

- `drawing_sheets` — `project_id` (CASCADE), `company_id` (`DEFAULT get_my_company_id()`), `discipline_prefix` (RAW verbatim prefix) / `discipline` (derived label) / `sheet_number` / `title`, `current_revision_id` (nullable, set after first revision), `search_vector` (STORED generated tsvector over `sheet_number + title + discipline`, mirroring submittals), audit columns.
- `drawing_revisions` — `sheet_id` (CASCADE), `company_id`, `revision_label`, `storage_path`, **`file_sha256`**, **`file_size`**, `source` (`NOT NULL DEFAULT 'uploaded'`, CHECK `('uploaded','bluebeam-markup')` — Phase-2 ready), audit columns.

Company-scoped RLS on both from creation (4 policies each, mirroring `subcontractor_people`). Indexes: `drawing_sheets(project_id)`, `drawing_sheets(company_id)`, composite `drawing_sheets(project_id, company_id, sheet_number)` (subsystem-4 sheet-existence lookup, NOT unique), GIN on `drawing_sheets(search_vector)`, `drawing_revisions(sheet_id)`, `drawing_revisions(file_sha256)`.

**Correction (2026-06-08, after ba5e556):** independent read-only review found 3 additive divergences from this spec in the first cut; corrected in place (additive ALTER, existing columns/policies/indexes untouched): (1) added `drawing_sheets.discipline_prefix`; (2) `drawing_revisions.source` given `DEFAULT 'uploaded'` + CHECK + NOT NULL; (3) added the composite `(project_id, company_id, sheet_number)` lookup index. Other first-cut choices left as-is by decision (nullable `company_id`/`sheet_number`/`storage_path`; `search_vector` includes `discipline`).

**Circular FK** (`drawing_sheets.current_revision_id` → `drawing_revisions.id` and `drawing_revisions.sheet_id` → `drawing_sheets.id`) resolved by creating both tables first (sheets' `current_revision_id` as a bare nullable column), then adding the back-reference FK last with `ON DELETE SET NULL`.

The ingest path (the **splitter** — subsystem 1) follows **ADR-001**: split an uploaded set → extract titleblock fields → stage proposed sheets → user confirms/edits → commit creates `drawing_sheets` + `drawing_revisions` and persists per-sheet files. Nothing becomes canonical without explicit confirmation.

Applied to prod 2026-06-08 (migration only; subsystems gated behind per-subsystem review).

## Rationale

- Sheet-as-identity with revisions underneath is the only shape that makes "current vs history" trivial and keeps file-integrity columns where they belong.
- Additive and pattern-consistent (RLS, search_vector, staging) — low risk, nothing existing touched.
- `source` reserved now means the future Bluebeam-markup path is a value, not a migration.

## Consequences

- Two inserts + a `current_revision_id` update per new sheet (a small commit-time transaction).
- The splitter must persist split files somewhere during staging and purge on abandon (mirror the existing spec-book staging auto-purge).
- `source` has no CHECK in v1 — provenance is by convention until/if it needs enforcement.

## Revisit triggers

- Phase 2: Bluebeam Studio API integration (markup round-trip) — revisit `source` (CHECK/enum) and possibly a markup-specific revision shape.
- If sheet-level metadata grows (issued-for, package, discipline taxonomy), revisit whether `discipline` should become an FK to a controlled list (cf. ADR-002's text-not-FK reasoning).
