-- Migration 0049: Field-role RESTRICTIVE gate policies — Phase 2 of ADR-020.
-- ADDITIVE ONLY: every statement adds (or re-adds) a RESTRICTIVE policy. No
-- existing policy, table, column, or function is modified or dropped. NO app
-- code. Requires 0047 (project_access + has_project_module_access /
-- has_project_visibility) — LIVE in prod.
--
-- NUMBERING: the task named this file 0048, but open PR #142
-- (feat/submittal-lead-time) already carries sql/migrations/0048_submittal_lead_time.sql
-- — same-number collision at merge (the 0043 lesson). 0049 is the next free
-- number across origin/master AND open PR branches.
--
-- HOW THE GATES WORK: restrictive policies AND onto the existing permissive
-- company-scoped policies. has_project_module_access() checks the role FIRST —
-- admin / member / demo short-circuit to true, so nothing changes for them.
-- Only role='field' falls through to the project_access grant lookup. A NULL
-- role (no user_profiles row) fails every branch → false; such users already
-- saw nothing through get_my_company_id() = NULL, so no behavior change.
--
-- NULL project_id SEMANTICS (verified against app code, not assumed):
--   * daily_reports.project_id is NULLABLE IN PRACTICE — POST /api/daily-reports
--     inserts `project_id: project_id || null`.
--   * rfis.project_id is NULLABLE BY DESIGN — POST /api/rfis numbers "per-project
--     if project_id given, otherwise global".
--   For field users: has_project_module_access(NULL, ...) → the EXISTS compares
--   project_id = NULL → no rows → false. So company-level / "global" rows are
--   AUTOMATICALLY invisible and unwritable to field users, while admin/member/
--   demo short-circuit true before project_id is ever consulted. This is the
--   intended rule; no per-table special-casing needed. (Under the project-first
--   IA both modules create from a /projects/[id]/ context, so field-created
--   rows always carry project_id.)
--   drawing_sheets / schedule_tasks / schedule_dependencies have
--   project_id NOT NULL (repo DDL) — no null case exists.
--
-- PARENT-EXISTS TABLES (no project_id of their own):
--   * drawing_revisions → parent drawing_sheets via sheet_id.
--   * item_photos → POLYMORPHIC (entity_type 'daily_report' | 'punch_item',
--     entity_id, NO FK, no project_id — verified in /api/photos +
--     src/lib/photo-sync.ts). Only daily_report photos ride the daily_reports
--     module; punch photos are field-denied (punch is not a field module).
--   These gates must short-circuit `get_my_role() <> 'field'` EXPLICITLY:
--   item_photos rows can be orphaned (photo synced before its report, parent
--   report later deleted — no FK), and a bare EXISTS would hide orphans from
--   ADMINS too. The OR keeps non-field behavior exactly as today.
--   Note for field offline sync: photo-sync drains reports before photos, but
--   a photo whose report insert failed will now be REJECTED (not inserted
--   unattached) and retried by the queue until the report lands — a slightly
--   stricter, self-healing ordering, not a breakage.
--
-- PROD-VERIFIED (Claude's prod review; this file matches what actually ran):
--   * item_photos.entity_id is uuid — the dr.id = entity_id comparison is
--     type-clean, no cast needed.
--   * equipment_availability AND commitment_balances are both views with
--     security_invoker=true — the base-table lockouts propagate through them.
--   * RLS is enabled on every public table — none of the policies below are
--     inert.
--   * daily_reports / rfis / drawing_log carry TEXT project_id in prod (see
--     Part 0) — the module-gate calls on those tables resolve to the text
--     overload.
--
-- ENUMERATION SOURCE: repo DDL + app .from() sweep, then reconciled against a
-- prod enumeration — which added commitment_changes and submittal_reviews to
-- the Part 4 lockout (the repo sweep missed them). The DO blocks still
-- RAISE NOTICE and SKIP any name that doesn't exist, and NOTICE any table
-- whose RLS is disabled — watch the NOTICE output when running.
--
-- POST-RUN VERIFICATION:
--   SELECT tablename, count(*) FROM pg_policies
--   WHERE policyname LIKE 'field\_%' GROUP BY 1 ORDER BY 1;
--   -- expect: 4 per gated table, 4 on projects, 1 per locked table,
--   --         3 per write-locked table.

BEGIN;

-- ============================================================================
-- PART 0 — TEXT overload of has_project_module_access.
-- daily_reports, rfis, and drawing_log carry TEXT project_id in prod (legacy
-- typing; the uuid-typed tables are drawing_sheets / schedule_* / projects),
-- and prod holds 4 live demo-seed rows with NON-UUID project_id values
-- ('LMOB'). A bare p_project::uuid in a policy would 22P02 on those rows for
-- EVERY role. So: same shape as the uuid original (0047); admin/member/demo
-- short-circuit true; for 'field' the value is regex-validated as a UUID
-- FIRST and only then delegated to the uuid version — non-uuid values (the
-- demo seeds) are simply not field-visible. Postgres overload resolution
-- routes each Part 1 call to the matching signature by the column's type.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.has_project_module_access(p_project text, p_module text, p_write boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN get_my_role() IN ('admin','member','demo') THEN true
    WHEN get_my_role() = 'field' THEN
      p_project ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND has_project_module_access(p_project::uuid, p_module, p_write)
    ELSE false
  END;
$$;

revoke all on function public.has_project_module_access(text, text, boolean) from public;
revoke all on function public.has_project_module_access(text, text, boolean) from anon;
grant execute on function public.has_project_module_access(text, text, boolean) to authenticated;

-- ============================================================================
-- PART 1 — MODULE GATES on the project-scoped tables.
-- 4 policies per table: read (SELECT, write=false) + insert/update/delete
-- (write=true). Restrictive FOR ALL is not usable here — its USING clause
-- would apply the write check to SELECT.
-- ============================================================================

-- ---- daily_reports → 'daily_reports' (project_id nullable in practice) -----
DROP POLICY IF EXISTS field_gate_read_daily_reports ON public.daily_reports;
CREATE POLICY field_gate_read_daily_reports ON public.daily_reports
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_module_access(project_id, 'daily_reports', false));
DROP POLICY IF EXISTS field_gate_insert_daily_reports ON public.daily_reports;
CREATE POLICY field_gate_insert_daily_reports ON public.daily_reports
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (has_project_module_access(project_id, 'daily_reports', true));
DROP POLICY IF EXISTS field_gate_update_daily_reports ON public.daily_reports;
CREATE POLICY field_gate_update_daily_reports ON public.daily_reports
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_project_module_access(project_id, 'daily_reports', true))
  WITH CHECK (has_project_module_access(project_id, 'daily_reports', true));
DROP POLICY IF EXISTS field_gate_delete_daily_reports ON public.daily_reports;
CREATE POLICY field_gate_delete_daily_reports ON public.daily_reports
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_project_module_access(project_id, 'daily_reports', true));

-- ---- item_photos → 'daily_reports' via parent-EXISTS (polymorphic) ---------
-- Field sees/writes ONLY photos whose entity is an accessible daily report;
-- punch_item (and any future entity_type) photos are field-denied. Explicit
-- role short-circuit keeps orphaned photos visible to non-field (see header).
DROP POLICY IF EXISTS field_gate_read_item_photos ON public.item_photos;
CREATE POLICY field_gate_read_item_photos ON public.item_photos
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    get_my_role() <> 'field'
    OR (entity_type = 'daily_report' AND EXISTS (
      SELECT 1 FROM public.daily_reports dr
      WHERE dr.id = item_photos.entity_id
        AND has_project_module_access(dr.project_id, 'daily_reports', false)
    ))
  );
DROP POLICY IF EXISTS field_gate_insert_item_photos ON public.item_photos;
CREATE POLICY field_gate_insert_item_photos ON public.item_photos
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() <> 'field'
    OR (entity_type = 'daily_report' AND EXISTS (
      SELECT 1 FROM public.daily_reports dr
      WHERE dr.id = item_photos.entity_id
        AND has_project_module_access(dr.project_id, 'daily_reports', true)
    ))
  );
DROP POLICY IF EXISTS field_gate_update_item_photos ON public.item_photos;
CREATE POLICY field_gate_update_item_photos ON public.item_photos
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    get_my_role() <> 'field'
    OR (entity_type = 'daily_report' AND EXISTS (
      SELECT 1 FROM public.daily_reports dr
      WHERE dr.id = item_photos.entity_id
        AND has_project_module_access(dr.project_id, 'daily_reports', true)
    ))
  )
  WITH CHECK (
    get_my_role() <> 'field'
    OR (entity_type = 'daily_report' AND EXISTS (
      SELECT 1 FROM public.daily_reports dr
      WHERE dr.id = item_photos.entity_id
        AND has_project_module_access(dr.project_id, 'daily_reports', true)
    ))
  );
DROP POLICY IF EXISTS field_gate_delete_item_photos ON public.item_photos;
CREATE POLICY field_gate_delete_item_photos ON public.item_photos
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    get_my_role() <> 'field'
    OR (entity_type = 'daily_report' AND EXISTS (
      SELECT 1 FROM public.daily_reports dr
      WHERE dr.id = item_photos.entity_id
        AND has_project_module_access(dr.project_id, 'daily_reports', true)
    ))
  );

-- ---- drawing_sheets → 'drawings' (project_id NOT NULL) ---------------------
DROP POLICY IF EXISTS field_gate_read_drawing_sheets ON public.drawing_sheets;
CREATE POLICY field_gate_read_drawing_sheets ON public.drawing_sheets
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_module_access(project_id, 'drawings', false));
DROP POLICY IF EXISTS field_gate_insert_drawing_sheets ON public.drawing_sheets;
CREATE POLICY field_gate_insert_drawing_sheets ON public.drawing_sheets
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (has_project_module_access(project_id, 'drawings', true));
DROP POLICY IF EXISTS field_gate_update_drawing_sheets ON public.drawing_sheets;
CREATE POLICY field_gate_update_drawing_sheets ON public.drawing_sheets
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_project_module_access(project_id, 'drawings', true))
  WITH CHECK (has_project_module_access(project_id, 'drawings', true));
DROP POLICY IF EXISTS field_gate_delete_drawing_sheets ON public.drawing_sheets;
CREATE POLICY field_gate_delete_drawing_sheets ON public.drawing_sheets
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_project_module_access(project_id, 'drawings', true));

-- ---- drawing_revisions → 'drawings' via parent drawing_sheets (no project_id)
DROP POLICY IF EXISTS field_gate_read_drawing_revisions ON public.drawing_revisions;
CREATE POLICY field_gate_read_drawing_revisions ON public.drawing_revisions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    get_my_role() <> 'field'
    OR EXISTS (
      SELECT 1 FROM public.drawing_sheets s
      WHERE s.id = drawing_revisions.sheet_id
        AND has_project_module_access(s.project_id, 'drawings', false)
    )
  );
DROP POLICY IF EXISTS field_gate_insert_drawing_revisions ON public.drawing_revisions;
CREATE POLICY field_gate_insert_drawing_revisions ON public.drawing_revisions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() <> 'field'
    OR EXISTS (
      SELECT 1 FROM public.drawing_sheets s
      WHERE s.id = drawing_revisions.sheet_id
        AND has_project_module_access(s.project_id, 'drawings', true)
    )
  );
DROP POLICY IF EXISTS field_gate_update_drawing_revisions ON public.drawing_revisions;
CREATE POLICY field_gate_update_drawing_revisions ON public.drawing_revisions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    get_my_role() <> 'field'
    OR EXISTS (
      SELECT 1 FROM public.drawing_sheets s
      WHERE s.id = drawing_revisions.sheet_id
        AND has_project_module_access(s.project_id, 'drawings', true)
    )
  )
  WITH CHECK (
    get_my_role() <> 'field'
    OR EXISTS (
      SELECT 1 FROM public.drawing_sheets s
      WHERE s.id = drawing_revisions.sheet_id
        AND has_project_module_access(s.project_id, 'drawings', true)
    )
  );
DROP POLICY IF EXISTS field_gate_delete_drawing_revisions ON public.drawing_revisions;
CREATE POLICY field_gate_delete_drawing_revisions ON public.drawing_revisions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    get_my_role() <> 'field'
    OR EXISTS (
      SELECT 1 FROM public.drawing_sheets s
      WHERE s.id = drawing_revisions.sheet_id
        AND has_project_module_access(s.project_id, 'drawings', true)
    )
  );

-- ---- drawing_log → 'drawings' [ADDITION to the spec'd list — reviewable] ---
-- The drawings module reads BOTH surfaces: drawing_sheets/revisions (viewer)
-- AND drawing_log (the log + transmittals; /api/drawings/[id]/pdf reads it).
-- Left un-gated, a field user WITHOUT a drawings grant would keep full
-- company-scoped access to the log; locked, a field user WITH the grant would
-- lose half the module. Gating it as 'drawings' is the only consistent
-- disposition. Out-of-band table; app queries filter .eq("project_id", ...),
-- so project_id exists — nullability unknown, and the NULL rule covers it.
DROP POLICY IF EXISTS field_gate_read_drawing_log ON public.drawing_log;
CREATE POLICY field_gate_read_drawing_log ON public.drawing_log
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_module_access(project_id, 'drawings', false));
DROP POLICY IF EXISTS field_gate_insert_drawing_log ON public.drawing_log;
CREATE POLICY field_gate_insert_drawing_log ON public.drawing_log
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (has_project_module_access(project_id, 'drawings', true));
DROP POLICY IF EXISTS field_gate_update_drawing_log ON public.drawing_log;
CREATE POLICY field_gate_update_drawing_log ON public.drawing_log
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_project_module_access(project_id, 'drawings', true))
  WITH CHECK (has_project_module_access(project_id, 'drawings', true));
DROP POLICY IF EXISTS field_gate_delete_drawing_log ON public.drawing_log;
CREATE POLICY field_gate_delete_drawing_log ON public.drawing_log
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_project_module_access(project_id, 'drawings', true));

-- ---- schedule_tasks → 'schedule' (project_id NOT NULL) ---------------------
-- (Soft-delete goes through SECURITY DEFINER RPCs, which bypass RLS — field
-- users with a schedule can_edit grant can therefore still soft-delete via
-- RPC. Route-level enforcement is the app-code phase's concern; noted, not a
-- schema gap this migration can close without touching the 0022 RPCs.)
DROP POLICY IF EXISTS field_gate_read_schedule_tasks ON public.schedule_tasks;
CREATE POLICY field_gate_read_schedule_tasks ON public.schedule_tasks
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_module_access(project_id, 'schedule', false));
DROP POLICY IF EXISTS field_gate_insert_schedule_tasks ON public.schedule_tasks;
CREATE POLICY field_gate_insert_schedule_tasks ON public.schedule_tasks
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (has_project_module_access(project_id, 'schedule', true));
DROP POLICY IF EXISTS field_gate_update_schedule_tasks ON public.schedule_tasks;
CREATE POLICY field_gate_update_schedule_tasks ON public.schedule_tasks
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_project_module_access(project_id, 'schedule', true))
  WITH CHECK (has_project_module_access(project_id, 'schedule', true));
DROP POLICY IF EXISTS field_gate_delete_schedule_tasks ON public.schedule_tasks;
CREATE POLICY field_gate_delete_schedule_tasks ON public.schedule_tasks
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_project_module_access(project_id, 'schedule', true));

-- ---- schedule_dependencies → 'schedule' (has its own project_id NOT NULL,
--      per 0022 — no parent-EXISTS needed) ----------------------------------
DROP POLICY IF EXISTS field_gate_read_schedule_dependencies ON public.schedule_dependencies;
CREATE POLICY field_gate_read_schedule_dependencies ON public.schedule_dependencies
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_module_access(project_id, 'schedule', false));
DROP POLICY IF EXISTS field_gate_insert_schedule_dependencies ON public.schedule_dependencies;
CREATE POLICY field_gate_insert_schedule_dependencies ON public.schedule_dependencies
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (has_project_module_access(project_id, 'schedule', true));
DROP POLICY IF EXISTS field_gate_update_schedule_dependencies ON public.schedule_dependencies;
CREATE POLICY field_gate_update_schedule_dependencies ON public.schedule_dependencies
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_project_module_access(project_id, 'schedule', true))
  WITH CHECK (has_project_module_access(project_id, 'schedule', true));
DROP POLICY IF EXISTS field_gate_delete_schedule_dependencies ON public.schedule_dependencies;
CREATE POLICY field_gate_delete_schedule_dependencies ON public.schedule_dependencies
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_project_module_access(project_id, 'schedule', true));

-- ---- rfis → 'rfis' (project_id nullable BY DESIGN — global RFIs are
--      field-invisible per the NULL rule) -----------------------------------
DROP POLICY IF EXISTS field_gate_read_rfis ON public.rfis;
CREATE POLICY field_gate_read_rfis ON public.rfis
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_module_access(project_id, 'rfis', false));
DROP POLICY IF EXISTS field_gate_insert_rfis ON public.rfis;
CREATE POLICY field_gate_insert_rfis ON public.rfis
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (has_project_module_access(project_id, 'rfis', true));
DROP POLICY IF EXISTS field_gate_update_rfis ON public.rfis;
CREATE POLICY field_gate_update_rfis ON public.rfis
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_project_module_access(project_id, 'rfis', true))
  WITH CHECK (has_project_module_access(project_id, 'rfis', true));
DROP POLICY IF EXISTS field_gate_delete_rfis ON public.rfis;
CREATE POLICY field_gate_delete_rfis ON public.rfis
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_project_module_access(project_id, 'rfis', true));

-- ============================================================================
-- PART 2 — projects: field sees only projects with ≥1 grant; field never
-- writes projects.
-- ============================================================================
DROP POLICY IF EXISTS field_gate_read_projects ON public.projects;
CREATE POLICY field_gate_read_projects ON public.projects
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_project_visibility(id));
DROP POLICY IF EXISTS field_gate_insert_projects ON public.projects;
CREATE POLICY field_gate_insert_projects ON public.projects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (get_my_role() <> 'field');
DROP POLICY IF EXISTS field_gate_update_projects ON public.projects;
CREATE POLICY field_gate_update_projects ON public.projects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (get_my_role() <> 'field')
  WITH CHECK (get_my_role() <> 'field');
DROP POLICY IF EXISTS field_gate_delete_projects ON public.projects;
CREATE POLICY field_gate_delete_projects ON public.projects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (get_my_role() <> 'field');

-- ============================================================================
-- PART 3 — WRITE-LOCK (field keeps SELECT, loses all writes) on the four
-- tables the field-facing surfaces must still READ:
--   team_members           — project shell + daily-report crew pickers
--   construction_managers,
--   project_cms            — RFI addressing ("To" pickers)
--   companies              — app chrome (company name); field must not edit
--   company_settings       — [DEVIATION from the spec'd full lockout, flagged]
--                            field-generated daily-report/RFI PDFs read the
--                            company logo/branding with the SESSION client; a
--                            SELECT lockout would silently strip branding from
--                            every field-generated PDF. Values are branding/
--                            templates, not secrets. Strike this row down to
--                            the Part-4 list to enforce the full lockout.
-- Restrictive policies only ever REMOVE access — safe to stack on tables
-- whose existing policies are out-of-band.
-- ============================================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'team_members', 'construction_managers', 'project_cms',
    'companies', 'company_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'field write-lock: public.% NOT FOUND — skipped, verify enumeration', t;
      CONTINUE;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || t)) THEN
      RAISE NOTICE 'field write-lock: public.% has RLS DISABLED — policy inert until enabled', t;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'field_no_write_ins_' || t, t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated
         WITH CHECK (get_my_role() <> 'field')$p$,
      'field_no_write_ins_' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'field_no_write_upd_' || t, t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated
         USING (get_my_role() <> 'field') WITH CHECK (get_my_role() <> 'field')$p$,
      'field_no_write_upd_' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'field_no_write_del_' || t, t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated
         USING (get_my_role() <> 'field')$p$,
      'field_no_write_del_' || t, t);
  END LOOP;
END $$;

-- ============================================================================
-- PART 4 — FULL FIELD LOCKOUT (no read, no write) on every other table.
-- Everything the app queries that is neither gated (Part 1–2), write-locked
-- (Part 3), nor deliberately left alone (project_access, user_profiles — see
-- the disposition table in PR #141). One FOR ALL restrictive policy per table:
-- USING covers SELECT/UPDATE/DELETE, WITH CHECK covers INSERT/UPDATE.
-- gmail-intake and the invite-accept flow use service-role / SECURITY DEFINER
-- and are unaffected by any of this.
-- ============================================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- submittals surface (incl. packages, spec/intake plumbing, counters;
    -- submittal_reviews: prod enumeration, repo sweep missed it)
    'submittals', 'submittal_attachments', 'submittal_reviews',
    'submittal_packages',
    'submittal_package_items', 'submittal_package_files',
    'submittal_package_reminders', 'staged_submittals', 'spec_sections',
    'project_scope_sections', 'project_submittal_counters',
    'project_package_counters',
    -- change orders
    'change_orders', 'change_order_line_items',
    -- commitments / POs (commitment_changes: prod enumeration, repo sweep missed it)
    'commitments', 'commitment_scope', 'commitment_invoices', 'po_line_items',
    'commitment_changes',
    -- estimation
    'estimates', 'estimate_lines', 'labor_rates', 'company_bid_defaults',
    'gc_template_items',
    -- RFQ / buyout
    'rfqs', 'rfq_recipients',
    -- directories (vendors et al. — nothing field-facing reads these)
    'vendors', 'vendor_people', 'project_vendors',
    'subcontractors', 'subcontractor_people', 'project_subcontractors',
    'suppliers', 'supplier_people', 'project_suppliers',
    -- equipment
    'equipment_items', 'equipment_units', 'equipment_assignments',
    -- admin / intake plumbing (gmail_connections holds OAuth tokens)
    'company_invites', 'gmail_connections', 'gmail_intake_skips',
    -- closeout
    'closeout_packages', 'closeout_items', 'closeout_package_items',
    'closeout_package_inbound', 'closeout_package_reminders',
    'project_closeout_package_counters',
    -- takeoff
    'takeoffs', 'takeoff_marks', 'takeoff_tags', 'takeoff_rooms',
    'takeoff_categories', 'takeoff_page_scales',
    -- punch (not a field module; punch photos already denied via item_photos)
    'punch_items',
    -- manpower
    'workers', 'manpower_assignments',
    -- general documents
    'project_documents'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'field lockout: public.% NOT FOUND — skipped, verify enumeration', t;
      CONTINUE;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || t)) THEN
      RAISE NOTICE 'field lockout: public.% has RLS DISABLED — policy inert until enabled', t;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'field_no_access_' || t, t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
         USING (get_my_role() <> 'field') WITH CHECK (get_my_role() <> 'field')$p$,
      'field_no_access_' || t, t);
  END LOOP;
END $$;

-- NOT POLICY-CAPABLE (views — PROD-VERIFIED, nothing to do):
--   * equipment_availability — security_invoker=true (0040): the equipment
--     lockout above propagates through it.
--   * commitment_balances — confirmed security_invoker=true in prod: the
--     commitments lockout propagates through it.

COMMIT;
