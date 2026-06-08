# ADR-004: Subcontractors/Suppliers Firm→People Restructure

**Date:** 2026-06-08
**Status:** Accepted
**Decision driver:** Submittal Log vendor entry — a firm can have multiple contacts, and the log/transmittal flow needs to address a specific person, not just the firm.

---

## Context

`subcontractors` and `suppliers` each model a *firm* but carry a single embedded contact (`contact_name`, `phone`, `email`) directly on the firm row. Real firms have more than one relevant person (estimating contact, PM, foreman), and the submittal transmittal flow needs to send to a specific person. The single-contact shape can't represent that.

Constraints at decision time:
- **Live data, low volume:** 4 subcontractors, 0 suppliers (single tenant). Migration risk is low, but it is production data — additive, reversible, no destructive changes.
- **Existing references must not break:** `subcontractors`/`suppliers` are already referenced from `project_subcontractors`, `project_suppliers`, `submittals` (`vendor_subcontractor_id` / `vendor_supplier_id`), and the transmittal `to_subcontractor_id` / `to_supplier_id` columns. Any restructure has to preserve all of these.
- Tenant isolation via company-scoped RLS (`company_id = get_my_company_id()`) is non-negotiable for any new table.

## Options considered

### Option A: Firm = existing tables; additive `*_people` child tables; nullable person FK on submittals
Keep `subcontractors`/`suppliers` as the firm record (untouched). Add `subcontractor_people` / `supplier_people` child tables (FK → parent, `ON DELETE CASCADE`). Add nullable `vendor_subcontractor_person_id` / `vendor_supplier_person_id` to `submittals` alongside the existing firm FKs.
- Pros: Purely additive — nothing dropped or altered, every existing FK reference keeps working; submittals can stay firm-only (null person) or gain a person; trivial backfill; cleanly reversible; lowest risk at this volume.
- Cons: Legacy `contact_*` columns on the firm rows linger as a separate cleanup; two ways to express "who" (firm vs person) until the UI + data converge.

### Option B: Unified `contacts`/`parties` table
Collapse firms and people into one normalized parties/contacts model with a type discriminator and self-referential parent.
- Pros: Single clean contact model long-term.
- Cons: Rewrites every existing FK into subcontractors/suppliers; high-risk migration of live data for no near-term payoff; large blast radius across modules.

### Option C: More contact columns on the firm row
Add `contact2_name`, `contact2_email`, … to the firm tables.
- Pros: No new tables.
- Cons: Caps the number of contacts; denormalized; can't FK a submittal to a specific contact; just postpones the real model.

## Decision

**Option A.** Firm stays as `subcontractors` / `suppliers`. People live in additive `subcontractor_people` / `supplier_people` child tables (company-scoped RLS mirroring the parent exactly, FK-column index, `ON DELETE CASCADE` from firm). `submittals` gains nullable `vendor_subcontractor_person_id` / `vendor_supplier_person_id` (`ON DELETE SET NULL`, mirroring the existing vendor firm FKs).

Backfill seeds one `role='primary'` person per existing firm from its current `contact_*` fields (verbatim — a faithful snapshot, no data cleaning). Existing submittals are left firm-only (null person). The legacy `contact_*` columns on the firm rows are intentionally **not** dropped — separate cleanup later.

Applied to prod 2026-06-08: Step 1 (DDL), then Step 2 (4 subcontractor people; 0 suppliers).

## Rationale

- Additive and reversible — preserves all existing FK references into `subcontractors`/`suppliers`; nothing existing is dropped or altered.
- Low-risk at this volume (4/0 rows), but follows a pattern that scales to many people per firm.
- Easier to add structure now and retire the legacy `contact_*` columns later than to attempt a unifying rewrite (Option B) against live data for no near-term benefit.

## Consequences

- Two representations of "who" coexist (firm FK + person FK) until the UI and data fully migrate to people.
- Legacy `contact_*` columns remain on firm rows — a known, deferred data-quality cleanup (includes the malformed `contact@ruotolomechanical` email, carried verbatim).
- The "add vendor inline" UI work is unblocked and tracked as a separate follow-up; the backfill is a plain `INSERT…SELECT` (not idempotent — re-running would duplicate).

## Revisit triggers

- If a unified cross-module contacts/parties model becomes worthwhile (e.g., contacts shared across CMs, architects, owners), revisit Option B.
- When the legacy `contact_*` columns are retired (separate cleanup ADR/migration).
