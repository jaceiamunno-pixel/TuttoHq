-- ============================================================================
-- Plain (non-builder) change order number uniqueness. Additive. Apply AFTER
-- 0045a (needs change_orders.deleted_at). Apply once in the Supabase SQL editor.
--
-- Partial unique index over LIVE, PLAIN rows only:
--   (project_id, co_number) WHERE has_pco_detail IS NOT TRUE AND deleted_at IS NULL
--
-- DISJOINT from the builder index uq_change_orders_project_pco_number
-- (WHERE has_pco_detail = true): has_pco_detail is BOOLEAN NOT NULL DEFAULT
-- false, so it is never NULL and `IS NOT TRUE` is exactly `= false`. No row can
-- satisfy both predicates at once, so the two indexes never contend. Plain
-- "CO-NNN" rows and builder pure-digit rows number independently within the
-- shared co_number column, and has_pco_detail is immutable after insert (only
-- save_pco sets it true, on INSERT) so a row never migrates between the indexes.
--
-- Verified read-only BEFORE adding: zero live duplicate (project_id, co_number)
-- rows among plain (has_pco_detail IS NOT TRUE) rows, so the index builds clean
-- with no remediation.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_orders_project_plain_number
  ON change_orders (project_id, co_number)
  WHERE has_pco_detail IS NOT TRUE AND deleted_at IS NULL;
