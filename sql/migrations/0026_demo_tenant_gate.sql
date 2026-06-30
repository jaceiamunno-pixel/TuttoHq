-- ==========================================================================
-- 0026_demo_tenant_gate.sql
-- ==========================================================================
-- Shared, READ-ONLY demo tenant. Cold signups land in one seeded demo company
-- (companies.is_demo = true) with a user_profiles row role='demo'. Tenant
-- isolation is the EXISTING company_id = get_my_company_id() gate; this migration
-- adds, on top of it, a write-block for demo users enforced in the DATABASE.
--
-- Run order note: folder max committed file is 0022, but prod has 0023/0024/0025
-- applied directly (per project history) with no committed file. This file is
-- numbered 0026 to sit AFTER the last applied migration. Rename if your
-- applied-migration record shows a different next free number.
--
-- ------------------------------------------------------------------------
-- DESIGN DEVIATION FROM THE BRIEF — READ BEFORE RUNNING
-- ------------------------------------------------------------------------
-- The brief specified ONE policy per table:
--     CREATE POLICY ... AS RESTRICTIVE FOR ALL
--       USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
-- and asserted this "lets demo users SELECT". It does NOT. A RESTRICTIVE FOR ALL
-- policy's USING clause is AND-ed into SELECT as well, so for a demo user
-- (NOT is_demo_user() = FALSE) every SELECT returns ZERO rows — the demo tenant
-- would be invisible to demo users, failing the brief's own acceptance gate
-- ("SELECT still returns for a demo user"). Verified empirically against this
-- database (temp table, rolled back):
--     Design A (FOR ALL):  demo SELECT = 0 rows   <-- broken
--     Design B (below):    demo SELECT = N rows, writes denied
-- A single policy cannot both allow demo SELECT and deny demo DELETE: both are
-- governed solely by USING, which would need opposite truth values. So this
-- migration uses the minimal correct form: THREE restrictive policies per table
-- (INSERT / UPDATE / DELETE). SELECT is left to the existing permissive
-- company-scoped read policy, so demo users browse normally. "RESTRICTIVE is
-- mandatory" is preserved. INSERT denial is a hard error; UPDATE/DELETE denial
-- is the standard RLS 0-rows-affected (no data changes = write denied).
--
-- ------------------------------------------------------------------------
-- TABLE LIST (50 tables) — every public table whose RLS policies are keyed on
-- get_my_company_id() AND that has at least one write (INSERT/UPDATE/DELETE/ALL)
-- policy. Derived from pg_policy introspection of the live schema, not guessed.
-- EXCLUDED: closeout_package_reminders, gmail_intake_skips, submittal_package_reminders
--   (company-scoped but SELECT-only — no write RLS to gate; their writes occur
--    via SECURITY DEFINER / service_role, which bypass RLS regardless. See the
--    "definer guard follow-up" note at the bottom.)
--     change_order_line_items
--     change_orders
--     closeout_items
--     closeout_package_inbound
--     closeout_package_items
--     closeout_packages
--     commitment_changes
--     commitment_invoices
--     commitment_scope
--     commitments
--     company_invites
--     company_settings
--     construction_managers
--     daily_reports
--     drawing_log
--     drawing_revisions
--     drawing_sheets
--     item_photos
--     labor_rates
--     manpower_assignments
--     po_line_items
--     project_closeout_package_counters
--     project_cms
--     project_documents
--     project_package_counters
--     project_scope_sections
--     project_subcontractors
--     project_submittal_counters
--     project_vendors
--     projects
--     punch_items
--     rfis
--     schedule_dependencies
--     schedule_tasks
--     spec_sections
--     staged_submittals
--     submittal_attachments
--     submittal_package_items
--     submittal_packages
--     submittal_reviews
--     submittals
--     takeoff_categories
--     takeoff_marks
--     takeoff_rooms
--     takeoff_tags
--     takeoffs
--     team_members
--     vendor_people
--     vendors
--     workers
-- ------------------------------------------------------------------------

BEGIN;

-- ==========================================================================
-- 1. is_demo flag on companies (locator for signup code; NOT the boundary)
-- ==========================================================================
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- ==========================================================================
-- 2. helper: is_demo_user() — composes with existing get_my_role()
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.is_demo_user()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$ SELECT coalesce(get_my_role() = 'demo', false) $$;

-- ==========================================================================
-- 3. per-table RESTRICTIVE write-block policies (demo users: read-only)
-- ==========================================================================

-- change_order_line_items
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.change_order_line_items;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.change_order_line_items;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.change_order_line_items;
CREATE POLICY demo_readonly_no_insert ON public.change_order_line_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.change_order_line_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.change_order_line_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- change_orders
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.change_orders;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.change_orders;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.change_orders;
CREATE POLICY demo_readonly_no_insert ON public.change_orders
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.change_orders
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.change_orders
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- closeout_items
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_items;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_items;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_items;
CREATE POLICY demo_readonly_no_insert ON public.closeout_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.closeout_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.closeout_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- closeout_package_inbound
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_package_inbound;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_package_inbound;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_package_inbound;
CREATE POLICY demo_readonly_no_insert ON public.closeout_package_inbound
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.closeout_package_inbound
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.closeout_package_inbound
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- closeout_package_items
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_package_items;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_package_items;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_package_items;
CREATE POLICY demo_readonly_no_insert ON public.closeout_package_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.closeout_package_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.closeout_package_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- closeout_packages
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_packages;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_packages;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_packages;
CREATE POLICY demo_readonly_no_insert ON public.closeout_packages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.closeout_packages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.closeout_packages
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- commitment_changes
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitment_changes;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitment_changes;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitment_changes;
CREATE POLICY demo_readonly_no_insert ON public.commitment_changes
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.commitment_changes
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.commitment_changes
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- commitment_invoices
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitment_invoices;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitment_invoices;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitment_invoices;
CREATE POLICY demo_readonly_no_insert ON public.commitment_invoices
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.commitment_invoices
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.commitment_invoices
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- commitment_scope
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitment_scope;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitment_scope;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitment_scope;
CREATE POLICY demo_readonly_no_insert ON public.commitment_scope
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.commitment_scope
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.commitment_scope
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- commitments
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitments;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitments;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitments;
CREATE POLICY demo_readonly_no_insert ON public.commitments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.commitments
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.commitments
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- company_invites
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.company_invites;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.company_invites;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.company_invites;
CREATE POLICY demo_readonly_no_insert ON public.company_invites
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.company_invites
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.company_invites
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- company_settings
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.company_settings;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.company_settings;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.company_settings;
CREATE POLICY demo_readonly_no_insert ON public.company_settings
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.company_settings
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.company_settings
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- construction_managers
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.construction_managers;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.construction_managers;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.construction_managers;
CREATE POLICY demo_readonly_no_insert ON public.construction_managers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.construction_managers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.construction_managers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- daily_reports
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.daily_reports;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.daily_reports;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.daily_reports;
CREATE POLICY demo_readonly_no_insert ON public.daily_reports
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.daily_reports
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.daily_reports
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- drawing_log
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.drawing_log;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.drawing_log;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.drawing_log;
CREATE POLICY demo_readonly_no_insert ON public.drawing_log
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.drawing_log
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.drawing_log
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- drawing_revisions
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.drawing_revisions;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.drawing_revisions;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.drawing_revisions;
CREATE POLICY demo_readonly_no_insert ON public.drawing_revisions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.drawing_revisions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.drawing_revisions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- drawing_sheets
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.drawing_sheets;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.drawing_sheets;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.drawing_sheets;
CREATE POLICY demo_readonly_no_insert ON public.drawing_sheets
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.drawing_sheets
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.drawing_sheets
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- item_photos
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.item_photos;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.item_photos;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.item_photos;
CREATE POLICY demo_readonly_no_insert ON public.item_photos
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.item_photos
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.item_photos
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- labor_rates
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.labor_rates;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.labor_rates;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.labor_rates;
CREATE POLICY demo_readonly_no_insert ON public.labor_rates
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.labor_rates
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.labor_rates
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- manpower_assignments
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.manpower_assignments;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.manpower_assignments;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.manpower_assignments;
CREATE POLICY demo_readonly_no_insert ON public.manpower_assignments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.manpower_assignments
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.manpower_assignments
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- po_line_items
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.po_line_items;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.po_line_items;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.po_line_items;
CREATE POLICY demo_readonly_no_insert ON public.po_line_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.po_line_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.po_line_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_closeout_package_counters
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_closeout_package_counters;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_closeout_package_counters;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_closeout_package_counters;
CREATE POLICY demo_readonly_no_insert ON public.project_closeout_package_counters
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_closeout_package_counters
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_closeout_package_counters
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_cms
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_cms;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_cms;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_cms;
CREATE POLICY demo_readonly_no_insert ON public.project_cms
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_cms
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_cms
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_documents
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_documents;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_documents;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_documents;
CREATE POLICY demo_readonly_no_insert ON public.project_documents
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_documents
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_documents
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_package_counters
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_package_counters;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_package_counters;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_package_counters;
CREATE POLICY demo_readonly_no_insert ON public.project_package_counters
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_package_counters
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_package_counters
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_scope_sections
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_scope_sections;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_scope_sections;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_scope_sections;
CREATE POLICY demo_readonly_no_insert ON public.project_scope_sections
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_scope_sections
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_scope_sections
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_subcontractors
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_subcontractors;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_subcontractors;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_subcontractors;
CREATE POLICY demo_readonly_no_insert ON public.project_subcontractors
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_subcontractors
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_subcontractors
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_submittal_counters
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_submittal_counters;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_submittal_counters;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_submittal_counters;
CREATE POLICY demo_readonly_no_insert ON public.project_submittal_counters
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_submittal_counters
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_submittal_counters
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- project_vendors
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_vendors;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_vendors;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_vendors;
CREATE POLICY demo_readonly_no_insert ON public.project_vendors
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.project_vendors
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.project_vendors
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- projects
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.projects;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.projects;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.projects;
CREATE POLICY demo_readonly_no_insert ON public.projects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.projects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.projects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- punch_items
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.punch_items;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.punch_items;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.punch_items;
CREATE POLICY demo_readonly_no_insert ON public.punch_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.punch_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.punch_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- rfis
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.rfis;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.rfis;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.rfis;
CREATE POLICY demo_readonly_no_insert ON public.rfis
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.rfis
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.rfis
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- schedule_dependencies
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.schedule_dependencies;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.schedule_dependencies;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.schedule_dependencies;
CREATE POLICY demo_readonly_no_insert ON public.schedule_dependencies
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.schedule_dependencies
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.schedule_dependencies
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- schedule_tasks
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.schedule_tasks;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.schedule_tasks;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.schedule_tasks;
CREATE POLICY demo_readonly_no_insert ON public.schedule_tasks
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.schedule_tasks
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.schedule_tasks
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- spec_sections
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.spec_sections;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.spec_sections;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.spec_sections;
CREATE POLICY demo_readonly_no_insert ON public.spec_sections
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.spec_sections
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.spec_sections
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- staged_submittals
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.staged_submittals;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.staged_submittals;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.staged_submittals;
CREATE POLICY demo_readonly_no_insert ON public.staged_submittals
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.staged_submittals
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.staged_submittals
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- submittal_attachments
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_attachments;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_attachments;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_attachments;
CREATE POLICY demo_readonly_no_insert ON public.submittal_attachments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.submittal_attachments
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.submittal_attachments
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- submittal_package_items
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_package_items;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_package_items;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_package_items;
CREATE POLICY demo_readonly_no_insert ON public.submittal_package_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.submittal_package_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.submittal_package_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- submittal_packages
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_packages;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_packages;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_packages;
CREATE POLICY demo_readonly_no_insert ON public.submittal_packages
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.submittal_packages
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.submittal_packages
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- submittal_reviews
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_reviews;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_reviews;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_reviews;
CREATE POLICY demo_readonly_no_insert ON public.submittal_reviews
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.submittal_reviews
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.submittal_reviews
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- submittals
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittals;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittals;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittals;
CREATE POLICY demo_readonly_no_insert ON public.submittals
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.submittals
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.submittals
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- takeoff_categories
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_categories;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_categories;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_categories;
CREATE POLICY demo_readonly_no_insert ON public.takeoff_categories
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.takeoff_categories
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.takeoff_categories
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- takeoff_marks
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_marks;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_marks;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_marks;
CREATE POLICY demo_readonly_no_insert ON public.takeoff_marks
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.takeoff_marks
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.takeoff_marks
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- takeoff_rooms
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_rooms;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_rooms;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_rooms;
CREATE POLICY demo_readonly_no_insert ON public.takeoff_rooms
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.takeoff_rooms
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.takeoff_rooms
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- takeoff_tags
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_tags;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_tags;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_tags;
CREATE POLICY demo_readonly_no_insert ON public.takeoff_tags
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.takeoff_tags
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.takeoff_tags
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- takeoffs
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoffs;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoffs;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoffs;
CREATE POLICY demo_readonly_no_insert ON public.takeoffs
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.takeoffs
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.takeoffs
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- team_members
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.team_members;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.team_members;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.team_members;
CREATE POLICY demo_readonly_no_insert ON public.team_members
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.team_members
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.team_members
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- vendor_people
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.vendor_people;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.vendor_people;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.vendor_people;
CREATE POLICY demo_readonly_no_insert ON public.vendor_people
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.vendor_people
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.vendor_people
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- vendors
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.vendors;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.vendors;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.vendors;
CREATE POLICY demo_readonly_no_insert ON public.vendors
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.vendors
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.vendors
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

-- workers
DROP POLICY IF EXISTS demo_readonly_no_insert ON public.workers;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.workers;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.workers;
CREATE POLICY demo_readonly_no_insert ON public.workers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.workers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_demo_user())
  WITH CHECK (NOT public.is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.workers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_demo_user());

COMMIT;

-- ==========================================================================
-- VERIFICATION (run as the postgres/owner role after COMMIT)
-- ==========================================================================
-- (a) Every write-scoped, company-keyed table should now have exactly 3 demo
--     restrictive policies. This query lists any such table that is MISSING them
--     (i.e. a table that drifted in after this migration was written):
--
--   SELECT c.relname AS table_missing_demo_block
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
--   WHERE c.relkind = 'r'
--     AND EXISTS (  -- has a company-keyed write policy
--       SELECT 1 FROM pg_policy p
--       WHERE p.polrelid = c.oid AND p.polcmd IN ('a','w','d','*')
--         AND (pg_get_expr(p.polqual, p.polrelid) LIKE '%get_my_company_id%'
--          OR  pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%get_my_company_id%'))
--     AND ( SELECT count(*) FROM pg_policy p2
--           WHERE p2.polrelid = c.oid AND p2.polname LIKE 'demo_readonly_no_%') < 3
--   ORDER BY 1;
--   -- expect: 0 rows
--
-- (b) Smoke against one table as a demo user (psql, replace <demo_uid>):
--     Demo SELECT must return rows; INSERT must error.
--   SET request.jwt.claim.sub = '<demo_uid>';  SET role authenticated;
--   SELECT count(*) FROM public.submittals;            -- expect > 0
--   INSERT INTO public.submittals (project_id) VALUES (NULL);  -- expect RLS error
--   RESET role;

-- ==========================================================================
-- ROLLBACK (down-path) — uncomment and run to fully reverse this migration
-- ==========================================================================
-- BEGIN;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.change_order_line_items;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.change_order_line_items;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.change_order_line_items;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.change_orders;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.change_orders;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.change_orders;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_items;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_items;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_items;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_package_inbound;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_package_inbound;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_package_inbound;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_package_items;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_package_items;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_package_items;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.closeout_packages;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.closeout_packages;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.closeout_packages;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitment_changes;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitment_changes;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitment_changes;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitment_invoices;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitment_invoices;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitment_invoices;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitment_scope;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitment_scope;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitment_scope;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.commitments;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.commitments;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.commitments;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.company_invites;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.company_invites;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.company_invites;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.company_settings;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.company_settings;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.company_settings;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.construction_managers;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.construction_managers;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.construction_managers;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.daily_reports;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.daily_reports;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.daily_reports;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.drawing_log;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.drawing_log;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.drawing_log;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.drawing_revisions;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.drawing_revisions;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.drawing_revisions;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.drawing_sheets;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.drawing_sheets;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.drawing_sheets;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.item_photos;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.item_photos;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.item_photos;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.labor_rates;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.labor_rates;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.labor_rates;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.manpower_assignments;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.manpower_assignments;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.manpower_assignments;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.po_line_items;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.po_line_items;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.po_line_items;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_closeout_package_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_closeout_package_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_closeout_package_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_cms;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_cms;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_cms;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_documents;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_documents;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_documents;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_package_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_package_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_package_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_scope_sections;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_scope_sections;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_scope_sections;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_subcontractors;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_subcontractors;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_subcontractors;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_submittal_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_submittal_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_submittal_counters;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_vendors;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_vendors;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_vendors;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.projects;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.projects;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.projects;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.punch_items;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.punch_items;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.punch_items;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.rfis;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.rfis;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.rfis;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.schedule_dependencies;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.schedule_dependencies;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.schedule_dependencies;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.schedule_tasks;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.schedule_tasks;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.schedule_tasks;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.spec_sections;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.spec_sections;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.spec_sections;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.staged_submittals;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.staged_submittals;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.staged_submittals;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_attachments;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_attachments;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_attachments;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_package_items;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_package_items;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_package_items;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_packages;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_packages;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_packages;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittal_reviews;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittal_reviews;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittal_reviews;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.submittals;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.submittals;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.submittals;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_categories;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_categories;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_categories;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_marks;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_marks;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_marks;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_rooms;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_rooms;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_rooms;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_tags;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_tags;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_tags;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoffs;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoffs;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoffs;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.team_members;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.team_members;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.team_members;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.vendor_people;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.vendor_people;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.vendor_people;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.vendors;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.vendors;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.vendors;
--   DROP POLICY IF EXISTS demo_readonly_no_insert ON public.workers;
--   DROP POLICY IF EXISTS demo_readonly_no_update ON public.workers;
--   DROP POLICY IF EXISTS demo_readonly_no_delete ON public.workers;
--   DROP FUNCTION IF EXISTS public.is_demo_user();
--   ALTER TABLE public.companies DROP COLUMN IF EXISTS is_demo;
-- COMMIT;

-- ==========================================================================
-- FOLLOW-UP (NOT done here — additive-only scope): SECURITY DEFINER demo guard
-- ==========================================================================
-- Soft-delete / counter RPCs that run SECURITY DEFINER bypass the RLS above. If a
-- demo user can reach any such RPC from the app, add an early guard inside it:
--     IF public.is_demo_user() THEN RAISE EXCEPTION 'demo tenant is read-only'
--       USING ERRCODE = '42501'; END IF;
-- Audit definer functions (soft-delete projects/submittals, PO numbering, package
-- counters) before exposing the demo tenant to writes through those paths.
