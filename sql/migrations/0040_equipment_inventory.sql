-- Migration 0040: Equipment Inventory — Phase 1 of N (ADR-018).
-- ADDITIVE ONLY. Creates three tables + the availability view + RLS + indexes +
-- soft-delete/restore RPCs. Nothing existing is altered.
--
-- Careful-lane: new tables, RLS, tenant isolation, a correctness invariant.
--
-- Model (ADR-018): the catalog (equipment_items) → physical units (equipment_units,
-- one row per THING, serial optional) → assignments (equipment_assignments, one open
-- row per unit while it's out). "Counts only" is a RENDERING of units with NULL
-- serials, never a separate schema path — so checkout is always at unit granularity.
--
-- Availability is DERIVED in a VIEW, never stored. No qty_available column, no
-- trigger-maintained counter, no generated column — a stored count drifts the first
-- time a checkout is edited or soft-deleted, and a drifted shop count silently lies.
--
-- House patterns mirror manpower_assignments (0021, live; file not committed) and the
-- schedule tables (0022): company_id DEFAULT get_my_company_id(), deleted_at soft
-- delete, SECURITY DEFINER soft-delete RPCs — NEVER a bare deleted_at UPDATE from a
-- route (the 42501 PostgREST/RLS RETURNING trap; see ADR-007 / 0020 / 0022).
--
-- RLS is SIX policies per table (shape of manpower_assignments — 3 permissive +
-- 3 restrictive, no permissive DELETE), all scoped `TO authenticated`:
--   PERMISSIVE  SELECT / INSERT / UPDATE  scoped to company_id = get_my_company_id()
--   RESTRICTIVE NOT is_demo_user()        on INSERT / UPDATE / DELETE
-- There is NO permissive DELETE policy → hard DELETE is denied for everyone; deletion
-- is soft-only, through the SECURITY DEFINER RPCs below.
--
-- DELIBERATE DIVERGENCE from prod manpower_assignments: its live SELECT policy is
--   USING ((company_id = get_my_company_id()) AND (deleted_at IS NULL))
-- — the deleted_at-in-policy 42501 RETURNING trap, sitting in prod. We do NOT copy
-- that. Our SELECT policies scope to company_id ONLY; deleted_at is filtered in the
-- view and in queries, never in the policy.
--
-- NUMBERING: highest committed migration file is 0039 (prod is applied past that via
-- the write connector; 0015–0021 were never committed as files). 0040 is next free.
--
-- Run by Jace in the Supabase SQL Editor. Claude reviews + verifies read-only before
-- and after. NO API / view consumers / UI in this phase.

BEGIN;

-- ============================================================================
-- Table 1: equipment_items — the CATALOG. One row per KIND of thing.
-- "14in cutoff saw." Not a physical unit — that's equipment_units below.
-- ============================================================================
CREATE TABLE public.equipment_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL DEFAULT get_my_company_id(),
  name        text        NOT NULL,                       -- "14in cutoff saw"
  description text,                                       -- optional free-text detail (nullable; beyond ADR's literal columns — drop if unwanted)
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        DEFAULT auth.uid(),
  deleted_at  timestamptz
);

-- ============================================================================
-- Table 2: equipment_units — one row per PHYSICAL thing. serial optional.
-- Owning 3 saws = 3 rows here, serial may be NULL on all of them. The UI
-- collapses to a count when every serial on an item is NULL (a rendering
-- decision). This keeps "which saw is at Long Lots?" and per-unit history free.
-- ============================================================================
CREATE TABLE public.equipment_units (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL DEFAULT get_my_company_id(),
  item_id     uuid        NOT NULL REFERENCES public.equipment_items(id),
  serial      text,                                       -- NULL for count-only items; not unique (blanks would collide)
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        DEFAULT auth.uid(),
  deleted_at  timestamptz
);

-- ============================================================================
-- Table 3: equipment_assignments — this unit, this holder, this span.
-- OPEN while returned_at IS NULL. Polymorphic holder: exactly one of
-- (project_id, worker_id, location_label) is populated, matching holder_type.
-- Real FKs on project_id / worker_id (NOT a bare holder_id UUID, which would
-- orphan silently on project/worker delete). location_label is free text — a
-- shop/yard is not a table until a GC asks to manage a list of them.
-- ============================================================================
CREATE TABLE public.equipment_assignments (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL DEFAULT get_my_company_id(),
  unit_id              uuid        NOT NULL REFERENCES public.equipment_units(id),
  holder_type          text        NOT NULL,
  project_id           uuid        REFERENCES public.projects(id),   -- holder_type = 'project'
  worker_id            uuid        REFERENCES public.workers(id),    -- holder_type = 'person' (workers = the manpower roster; manpower_assignments.worker_id points here too)
  location_label       text,                                        -- holder_type = 'location'; free text
  checked_out_at       timestamptz NOT NULL DEFAULT now(),          -- span start
  returned_at          timestamptz,                                 -- span end; NULL = still out (open)
  expected_return_date date,                                        -- soft, UNENFORCED — nothing blocks on it
  notes                text,                                        -- optional (nullable; beyond ADR's literal columns — drop if unwanted)
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        DEFAULT auth.uid(),
  deleted_at           timestamptz,
  CONSTRAINT equipment_assignment_holder_type CHECK (holder_type IN ('project','person','location')),
  -- EXACTLY ONE holder column populated, and it must match holder_type.
  CONSTRAINT equipment_assignment_holder_exclusive CHECK (
       (holder_type = 'project'  AND project_id     IS NOT NULL AND worker_id IS NULL AND location_label IS NULL)
    OR (holder_type = 'person'   AND worker_id      IS NOT NULL AND project_id IS NULL AND location_label IS NULL)
    OR (holder_type = 'location' AND location_label IS NOT NULL AND project_id IS NULL AND worker_id IS NULL)
  ),
  -- Span can't end before it starts (data-integrity guard; mirrors 0022's
  -- schedule_task_date_order. Beyond ADR's literal text — safe to drop).
  CONSTRAINT equipment_assignment_return_after_checkout CHECK (returned_at IS NULL OR returned_at >= checked_out_at)
);

-- ============================================================================
-- THE INVARIANT — a unit cannot be in two places at once.
-- Only ONE open (returned_at IS NULL), non-deleted assignment per unit. Without
-- this, double-checkout is possible and `available` can go negative. Enforced in
-- the database, NEVER in application code.
-- ============================================================================
CREATE UNIQUE INDEX equipment_assignments_one_open_per_unit
  ON public.equipment_assignments (unit_id)
  WHERE returned_at IS NULL AND deleted_at IS NULL;

-- ============================================================================
-- Indexes — RLS-scoped scans (company_id), catalog rollup (item_id), holder
-- lookups, and the hot active-rows reads (partial WHERE deleted_at IS NULL).
-- ============================================================================
CREATE INDEX idx_equipment_items_company        ON public.equipment_items (company_id);

CREATE INDEX idx_equipment_units_company        ON public.equipment_units (company_id);
CREATE INDEX idx_equipment_units_item           ON public.equipment_units (item_id);
CREATE INDEX idx_equipment_units_item_active    ON public.equipment_units (item_id) WHERE deleted_at IS NULL;

-- A serial identifies one physical machine within a company. Enforce that: no two
-- live units in the same company may claim the same serial. Company-scoped (two GCs
-- can own the same manufacturer serial) and partial on serial IS NOT NULL so the
-- NULL serials that back count-only mode are unconstrained. NOT (item_id, serial):
-- a scanned barcode yields a bare serial with no item context and must resolve to
-- exactly one unit company-wide (the deferred scan-out path). Cost: blocks the rare
-- cross-manufacturer serial collision within one company — accepted (typo > genuine).
CREATE UNIQUE INDEX equipment_units_serial_unique
  ON public.equipment_units (company_id, serial)
  WHERE serial IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_equipment_assignments_company  ON public.equipment_assignments (company_id);
CREATE INDEX idx_equipment_assignments_unit     ON public.equipment_assignments (unit_id);
CREATE INDEX idx_equipment_assignments_project  ON public.equipment_assignments (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_equipment_assignments_worker   ON public.equipment_assignments (worker_id)  WHERE worker_id  IS NOT NULL;

-- ============================================================================
-- RLS — company-scoped from creation (mirrors manpower_assignments). authenticated
-- only; no anon policy → anon is denied by default under RLS.
--
-- SIX policies per table: 3 PERMISSIVE (SELECT/INSERT/UPDATE) + 3 RESTRICTIVE
-- (NOT is_demo_user() on INSERT/UPDATE/DELETE). No permissive DELETE → hard DELETE
-- is denied for everyone; soft-delete only, via the RPCs below.
--
-- CRITICAL: the SELECT policy scopes to company_id ONLY. It must NOT contain
-- `deleted_at IS NULL` — that triggers the 42501 PostgREST RETURNING error on
-- soft-delete UPDATEs. deleted_at is filtered in the view and in queries instead.
-- ============================================================================
ALTER TABLE public.equipment_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_units       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_assignments ENABLE ROW LEVEL SECURITY;

-- ---- equipment_items -------------------------------------------------------
CREATE POLICY equipment_items_select ON public.equipment_items
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());
CREATE POLICY equipment_items_insert ON public.equipment_items
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY equipment_items_update ON public.equipment_items
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY demo_readonly_no_insert ON public.equipment_items
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.equipment_items
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.equipment_items
  AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT is_demo_user());

-- ---- equipment_units -------------------------------------------------------
CREATE POLICY equipment_units_select ON public.equipment_units
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());
CREATE POLICY equipment_units_insert ON public.equipment_units
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY equipment_units_update ON public.equipment_units
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY demo_readonly_no_insert ON public.equipment_units
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.equipment_units
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.equipment_units
  AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT is_demo_user());

-- ---- equipment_assignments -------------------------------------------------
CREATE POLICY equipment_assignments_select ON public.equipment_assignments
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());
CREATE POLICY equipment_assignments_insert ON public.equipment_assignments
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY equipment_assignments_update ON public.equipment_assignments
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY demo_readonly_no_insert ON public.equipment_assignments
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.equipment_assignments
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.equipment_assignments
  AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT is_demo_user());

-- ============================================================================
-- AVAILABILITY VIEW — derived, never stored.
--   owned       = count(units where deleted_at is null)
--   checked_out = count(open, non-deleted assignments on those units)
--   available   = owned - checked_out
--
-- One row per (non-deleted) catalog item, including items with zero units owned
-- (owned = 0, available = 0). The one-open-per-unit invariant guarantees
-- checked_out <= owned, so available is never negative.
--
-- security_invoker = true (PG15+): the view runs with the QUERYING user's
-- privileges, so the base tables' company-scoped RLS applies THROUGH the view.
-- Without it the view would run as its owner (RLS-bypassing) and leak every
-- company's counts to any authenticated caller — a tenant-isolation break.
-- deleted_at is filtered HERE (in the view), never in the RLS policy.
-- ============================================================================
CREATE VIEW public.equipment_availability
  WITH (security_invoker = true)
AS
SELECT
  i.id                                        AS item_id,
  i.company_id                                AS company_id,
  i.name                                      AS name,
  count(DISTINCT u.id)                        AS owned,
  count(DISTINCT a.id)                        AS checked_out,
  count(DISTINCT u.id) - count(DISTINCT a.id) AS available
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

-- The view is reachable only by authenticated (and RLS-scoped via security_invoker).
-- Revoke the implicit anon/PUBLIC grants Supabase's default privileges would add.
REVOKE ALL ON public.equipment_availability FROM PUBLIC;
REVOKE ALL ON public.equipment_availability FROM anon;
GRANT SELECT ON public.equipment_availability TO authenticated;

-- ============================================================================
-- Soft-delete / restore RPCs — exact mirror of soft_delete_worker (0021) /
-- soft_delete_schedule_task (0022): LANGUAGE sql, SECURITY DEFINER, pinned
-- search_path, company-scoped internally via get_my_company_id(), RETURNING id.
-- These are the ONLY delete path (no permissive DELETE policy exists).
--
-- Deleting a unit does NOT auto-return its open assignments — the availability
-- view already drops a deleted unit from both `owned` and `checked_out`, so the
-- count stays correct. Returning/closing an assignment before retiring a unit is
-- an application-layer concern, not a schema one.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.soft_delete_equipment_item(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.equipment_items SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.restore_equipment_item(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.equipment_items SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_equipment_unit(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.equipment_units SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.restore_equipment_unit(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.equipment_units SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_equipment_assignment(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.equipment_assignments SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.restore_equipment_assignment(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.equipment_assignments SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$$;

-- EXECUTE grants: authenticated only. Revoke from PUBLIC *and* explicitly from
-- anon — Supabase default privileges grant EXECUTE to anon directly, so
-- `revoke from public` alone does NOT strip anon's grant (see 0029b).
REVOKE ALL ON FUNCTION public.soft_delete_equipment_item(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_equipment_item(uuid)       FROM anon;
REVOKE ALL ON FUNCTION public.restore_equipment_item(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_equipment_item(uuid)           FROM anon;
REVOKE ALL ON FUNCTION public.soft_delete_equipment_unit(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_equipment_unit(uuid)       FROM anon;
REVOKE ALL ON FUNCTION public.restore_equipment_unit(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_equipment_unit(uuid)           FROM anon;
REVOKE ALL ON FUNCTION public.soft_delete_equipment_assignment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_equipment_assignment(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.restore_equipment_assignment(uuid)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_equipment_assignment(uuid)     FROM anon;

GRANT EXECUTE ON FUNCTION public.soft_delete_equipment_item(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_equipment_item(uuid)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_equipment_unit(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_equipment_unit(uuid)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_equipment_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_equipment_assignment(uuid)     TO authenticated;

COMMIT;
