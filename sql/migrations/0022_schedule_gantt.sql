-- Migration 0022: Construction Schedule / Gantt — Phase 1 of 5 (ADR-011).
-- ADDITIVE ONLY. Creates the two schedule tables + RLS + indexes + soft-delete RPCs.
-- Nothing existing is altered. Mirrors the Manpower 0021 tenant/soft-delete pattern:
-- get_my_company_id()-scoped RLS, SECURITY DEFINER soft-delete RPCs — NEVER a bare
-- `deleted_at` UPDATE from a route (the 42501 PostgREST/RLS trap; see ADR-007 / 0020).
--
-- NUMBERING: prod is at applied migration 0021 (Manpower). Migrations 0015–0021 were
-- applied via the Claude write connector and are NOT committed as files in this repo
-- (highest committed file is 0014). 0022 is the next free number.
--
-- Run by Jace in the Supabase SQL Editor. Claude reviews + verifies read-only before
-- and after. NO API / CPM engine / UI in this phase (those are Phases 2–5).

BEGIN;

-- ============================================================================
-- Table 1: schedule_tasks — one row per activity / phase band / milestone.
-- ============================================================================
CREATE TABLE public.schedule_tasks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid        NOT NULL REFERENCES public.projects(id),
  company_id        uuid        NOT NULL DEFAULT get_my_company_id(),
  name              text        NOT NULL,
  phase             text,                                  -- nullable free-text grouping band (v1; not a lookup)
  start_date        date        NOT NULL,
  end_date          date        NOT NULL,
  is_milestone      boolean     NOT NULL DEFAULT false,
  duration_days     integer,                               -- WORKING-day duration (Mon–Fri); engine may derive
  percent_complete  integer     NOT NULL DEFAULT 0,
  actual_start_date date,
  actual_end_date   date,
  sort_order        integer     NOT NULL DEFAULT 0,
  wbs_code          text,                                  -- optional outline code; flat in v1 (parent_id deferred)
  status            text        NOT NULL DEFAULT 'not_started',
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        DEFAULT auth.uid(),
  deleted_at        timestamptz,
  CONSTRAINT schedule_task_date_order CHECK (end_date >= start_date),
  CONSTRAINT schedule_task_pct        CHECK (percent_complete BETWEEN 0 AND 100),
  CONSTRAINT schedule_task_status     CHECK (status IN ('not_started','in_progress','complete'))
);

-- ============================================================================
-- Table 2: schedule_dependencies — the dependency edge graph between tasks.
-- Edges HARD-delete (no deleted_at); task removal cascades via the FKs below.
-- ============================================================================
CREATE TABLE public.schedule_dependencies (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL REFERENCES public.projects(id),
  company_id     uuid        NOT NULL DEFAULT get_my_company_id(),
  predecessor_id uuid        NOT NULL REFERENCES public.schedule_tasks(id) ON DELETE CASCADE,
  successor_id   uuid        NOT NULL REFERENCES public.schedule_tasks(id) ON DELETE CASCADE,
  dep_type       text        NOT NULL DEFAULT 'FS',
  lag_days       integer     NOT NULL DEFAULT 0,           -- working days; negative = lead
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        DEFAULT auth.uid(),
  CONSTRAINT schedule_dep_type   CHECK (dep_type IN ('FS','SS','FF','SF')),
  CONSTRAINT no_self_dependency  CHECK (predecessor_id <> successor_id),
  CONSTRAINT schedule_dep_unique UNIQUE (predecessor_id, successor_id)
);
-- NOTE: cycle prevention is NOT a DB constraint (Postgres can't express acyclicity
-- cheaply) — it is an APP gate enforced on edge-insert in Phase 3 (DFS/topo check).

-- ============================================================================
-- Indexes
-- ============================================================================
-- schedule_tasks: company_id (RLS-scoped scans), project_id (project scoping),
-- and the hot active-rows read (project_id WHERE deleted_at IS NULL).
CREATE INDEX idx_schedule_tasks_company        ON public.schedule_tasks (company_id);
CREATE INDEX idx_schedule_tasks_project        ON public.schedule_tasks (project_id);
CREATE INDEX idx_schedule_tasks_project_active ON public.schedule_tasks (project_id) WHERE deleted_at IS NULL;

-- schedule_dependencies: project scoping + reverse-edge (successor) lookups.
-- predecessor_id-leading lookups are already served by the schedule_dep_unique
-- index on (predecessor_id, successor_id); the standalone predecessor_id index is
-- included per the ADR-011 index list (belt-and-suspenders; safe to drop).
CREATE INDEX idx_schedule_deps_project     ON public.schedule_dependencies (project_id);
CREATE INDEX idx_schedule_deps_predecessor ON public.schedule_dependencies (predecessor_id);
CREATE INDEX idx_schedule_deps_successor   ON public.schedule_dependencies (successor_id);

-- ============================================================================
-- RLS — company-scoped from creation (mirrors Manpower 0021). authenticated only;
-- no anon policy → anon is denied by default under RLS.
-- ============================================================================
ALTER TABLE public.schedule_tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_dependencies ENABLE ROW LEVEL SECURITY;

-- schedule_tasks: SELECT hides soft-deleted rows. No hard-DELETE policy — deletion
-- goes through the SECURITY DEFINER RPCs below (which bypass RLS as definer).
CREATE POLICY schedule_tasks_select ON public.schedule_tasks
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id() AND deleted_at IS NULL);

CREATE POLICY schedule_tasks_insert ON public.schedule_tasks
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY schedule_tasks_update ON public.schedule_tasks
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());

-- schedule_dependencies: edges hard-delete, so an explicit DELETE policy is REQUIRED
-- (a missing DELETE policy = silent no-op; see CLAUDE.md RLS note). UPDATE included
-- so a future edit of lag_days / dep_type isn't blocked by a missing policy.
CREATE POLICY schedule_deps_select ON public.schedule_dependencies
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

CREATE POLICY schedule_deps_insert ON public.schedule_dependencies
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY schedule_deps_update ON public.schedule_dependencies
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY schedule_deps_delete ON public.schedule_dependencies
  FOR DELETE TO authenticated
  USING (company_id = get_my_company_id());

-- ============================================================================
-- Soft-delete / restore RPCs — exact mirror of soft_delete_worker (0021):
-- LANGUAGE sql, SECURITY DEFINER, SET search_path TO 'public', RETURNING id.
-- Company-scoped internally via get_my_company_id(). The edge table needs no RPC
-- (edges hard-delete; the FK CASCADE handles task removal).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.soft_delete_schedule_task(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.schedule_tasks SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.restore_schedule_task(p_id uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.schedule_tasks SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$$;

-- Grant EXECUTE to authenticated only; revoke the default PUBLIC grant so anon
-- cannot execute (guarantees the authenticated:yes / anon:no verification).
REVOKE ALL ON FUNCTION public.soft_delete_schedule_task(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_schedule_task(uuid)     FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.soft_delete_schedule_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_schedule_task(uuid)     TO authenticated;

COMMIT;
