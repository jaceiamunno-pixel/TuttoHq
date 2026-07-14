-- ============================================================================
-- RFI per-project number uniqueness. Additive. Apply AFTER 0043 (needs
-- rfis.deleted_at). Apply once in the Supabase SQL editor.
--
-- Partial unique index over LIVE rows only (deleted_at IS NULL). The DB becomes
-- the source of truth for (project_id, rfi_number) among visible RFIs, so:
--   * a race between two concurrent creates cannot double-assign a number
--     (the loser gets 23505 and the route re-derives MAX+1 and retries), and
--   * a number belonging to a soft-deleted RFI is excluded, so the permanent
--     gap it leaves never blocks a visible row.
--
-- Verified read-only BEFORE adding: zero live duplicate (project_id, rfi_number)
-- rows, so the index builds clean with no remediation.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_rfis_project_number
  ON rfis (project_id, rfi_number)
  WHERE deleted_at IS NULL;
