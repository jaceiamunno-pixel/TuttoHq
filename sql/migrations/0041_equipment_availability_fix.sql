-- Migration 0041: equipment_availability view — count units, not assignment rows.
-- VIEW-ONLY. Idempotent (CREATE OR REPLACE VIEW). No table/RLS/RPC changes.
--
-- Bug being fixed (ADR-018 conformance):
--   0040's view computed checked_out / available with count(DISTINCT a.id) — the
--   number of open assignment ROWS. That is only equal to the number of checked-out
--   UNITS because the `equipment_assignments_one_open_per_unit` partial unique index
--   currently guarantees at most one open row per unit. The count is therefore
--   correct today only by relying on that invariant holding.
--
--   ADR-018 specified count(DISTINCT a.unit_id) so the count is correct BY
--   CONSTRUCTION — it measures the quantity we actually mean (distinct units that
--   are out) regardless of the index. This aligns the view with the spec and makes
--   `available = owned - checked_out` robust even if the invariant were ever relaxed.
--
-- Change: count(DISTINCT a.id) → count(DISTINCT a.unit_id) in BOTH `checked_out`
-- and `available`. Column list, joins, filters, GROUP BY, and security posture are
-- otherwise IDENTICAL to 0040.
--
-- security_invoker = true (matches 0040 and commitment_balances / 0012): the view
-- runs with the QUERYING user's privileges, so the base tables' company-scoped RLS
-- applies THROUGH the view. Without it the view runs as owner, bypasses RLS, and
-- leaks every company's counts. LOAD-BEARING — do not drop.
--
-- CREATE OR REPLACE VIEW preserves existing privileges; the REVOKE/GRANT block is
-- re-asserted for self-containment (harmless on re-run, and correct on a fresh DB).
--
-- Run by Jace in the Supabase SQL Editor. NO API / UI consumers in this pass.

BEGIN;

CREATE OR REPLACE VIEW public.equipment_availability
  WITH (security_invoker = true)
AS
SELECT
  i.id                                             AS item_id,
  i.company_id                                     AS company_id,
  i.name                                           AS name,
  count(DISTINCT u.id)                             AS owned,
  count(DISTINCT a.unit_id)                        AS checked_out,
  count(DISTINCT u.id) - count(DISTINCT a.unit_id) AS available
FROM public.equipment_items i
LEFT JOIN public.equipment_units u
  ON u.item_id = i.id
 AND u.deleted_at IS NULL
LEFT JOIN public.equipment_assignments a
  ON a.unit_id = u.id
 AND a.returned_at IS NULL
 AND a.deleted_at  IS NULL
WHERE i.deleted_at IS NULL
GROUP BY i.id, i.company_id, i.name;

-- Re-assert the grants (CREATE OR REPLACE keeps existing ones; this makes the file
-- self-contained). Authenticated only; anon/PUBLIC denied.
REVOKE ALL ON public.equipment_availability FROM PUBLIC;
REVOKE ALL ON public.equipment_availability FROM anon;
GRANT SELECT ON public.equipment_availability TO authenticated;

COMMIT;
