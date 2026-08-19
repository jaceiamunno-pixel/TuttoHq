-- =============================================================================
-- Migration 0053: Sub CO — manual override for prior contract history
-- (0052 = sub_change_orders; 0053 was the next free number across origin/master,
-- all remote branches, and every open PR's files.)
--
-- Why: rows 2/3 of the CO recap ("Previous Additions" / "Previous Deductions")
-- are DERIVED by summing earlier sub_change_orders for the same
-- (project, vendor). A subcontract whose change-order history predates TuttoHQ
-- has no such rows, so 2 and 3 print $0.00 and rows 4/6 come out wrong. These
-- two nullable columns let the user type the prior magnitudes; the server-side
-- recap prefers them over the derived sums (NULL = keep auto-computing).
--
-- Additive only. Nullable. No backfill, so every existing row keeps NULL and
-- therefore today's exact behavior. No RLS changes needed — the 0052 policies
-- on sub_change_orders are column-agnostic and already cover new columns.
--
-- Both values are MAGNITUDES as printed on the form (additions and deductions
-- are separate positive lines), so the CHECK forbids negatives. The route-level
-- validation is the first line of defense; this constraint is the backstop.
--
-- Run manually in the Supabase SQL Editor. Idempotent — safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE public.sub_change_orders
  ADD COLUMN IF NOT EXISTS prior_additions_override  numeric,
  ADD COLUMN IF NOT EXISTS prior_deductions_override numeric;

ALTER TABLE public.sub_change_orders
  DROP CONSTRAINT IF EXISTS sub_change_orders_prior_overrides_nonneg;

ALTER TABLE public.sub_change_orders
  ADD CONSTRAINT sub_change_orders_prior_overrides_nonneg CHECK (
    (prior_additions_override  IS NULL OR prior_additions_override  >= 0)
    AND (prior_deductions_override IS NULL OR prior_deductions_override >= 0)
  );

COMMIT;
