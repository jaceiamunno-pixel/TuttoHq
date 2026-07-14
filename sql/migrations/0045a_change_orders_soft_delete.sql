-- ============================================================================
-- Change order soft-delete — column. Additive. Apply once in the Supabase SQL
-- editor.
--
-- MUST be paired with 0045b (freeze-trigger rewrite) BEFORE the soft-delete
-- DELETE route ships: the change_orders_freeze_imported() trigger (0005) rejects
-- ANY non-workflow column change on an imported PCO, and deleted_at is not yet in
-- its allow-list — so without 0045b, imported PCOs become un-soft-deletable
-- (the soft-delete UPDATE raises restrict_violation).
--
-- Numbering (create route) derives MAX over ALL rows including soft-deleted, so a
-- deleted CO-004 leaves a permanent gap and its number is never recycled.
-- deleted_at is filtered IN-QUERY, NEVER in the RLS SELECT policy (42501 trap).
-- ============================================================================

ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
