-- ============================================================================
-- RFI soft-delete — column. Additive. Apply once in the Supabase SQL editor.
--
-- Adds deleted_at so RFI deletes become reversible and RFI numbers stay
-- PERMANENT identifiers: the create-route numbering derives MAX over ALL rows
-- (including soft-deleted), so a deleted RFI-004 leaves a permanent gap and its
-- number is never recycled (see 0044 + src/app/api/rfis/route.ts).
--
-- deleted_at is filtered IN-QUERY (and via SECURITY DEFINER where applicable),
-- NEVER in the RLS SELECT policy — putting deleted_at IS NULL in a SELECT policy
-- triggers the 42501 UPDATE ... RETURNING trap (ADR-007 / 0020 / 0040).
-- ============================================================================

ALTER TABLE rfis ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
