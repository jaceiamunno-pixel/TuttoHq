-- Migration 0047: Field role + project_access — Phase 1 of ADR-020.
-- SCHEMA ONLY. Widens the two role CHECKs, creates project_access (+ RLS),
-- adds the two access-check helper functions, and adds company_invites.project_grants.
-- NO RLS gate policies on existing tables (that is a later migration), no app
-- code, no data writes.
--
-- NUMBERING: highest committed migration on origin/master is 0046 (twice:
-- 0046_dryrun.sql + 0046_review_status_vocabulary.sql). 0047 is next free.
-- The supabase_migrations ledger is stale — do not trust it.
--
-- PREFLIGHT NOTES for the runner (Jace, Supabase SQL Editor):
--   * The 'demo' role + is_demo_user() came from the out-of-band demo-tenant
--     migrations (0026–0028, never committed as files), so the live definition
--     of user_profiles_role_check is not in the repo. The DROP IF EXISTS +
--     ADD below replaces whatever is there — but only under that exact name.
--     After running, verify each table has exactly ONE role CHECK:
--       SELECT conrelid::regclass, conname, pg_get_constraintdef(oid)
--       FROM pg_constraint
--       WHERE conname LIKE '%role_check%';
--   * ADD CONSTRAINT ... CHECK validates existing rows. user_profiles holds
--     admin/member/demo — all inside the new set. company_invites should hold
--     only admin/member; a stray 'demo' invite row (there should be none)
--     would make that ALTER fail loudly rather than corrupt anything.
--
-- Idempotent-safe: IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE
-- throughout (CREATE POLICY has no IF NOT EXISTS, so policies are
-- DROP-then-CREATE).

BEGIN;

-- ============================================================================
-- 1. ROLE CHECK EXPANSIONS — add 'field' to both vocabularies.
--    user_profiles keeps 'demo' (live demo-tenant users carry it);
--    company_invites does NOT get 'demo' (demo users are provisioned, never
--    invited).
-- ============================================================================
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('admin','member','field','demo'));

ALTER TABLE public.company_invites
  DROP CONSTRAINT IF EXISTS company_invites_role_check;
ALTER TABLE public.company_invites
  ADD CONSTRAINT company_invites_role_check
  CHECK (role IN ('admin','member','field'));

-- ============================================================================
-- 2. project_access — per-project, per-module grants for 'field' users.
--    One row = "this user may see (and optionally edit) this module on this
--    project." Non-field roles never consult this table (see the functions
--    below). Grants are admin-managed and hard-deleted — revoking access is
--    not a record worth keeping, so no deleted_at / soft-delete machinery.
--
--    company_id: NOT NULL DEFAULT get_my_company_id() — the house
--    column-default pattern (0040 equipment / manpower / schedule tables).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.project_access (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL DEFAULT get_my_company_id(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid        NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  module     text        NOT NULL,
  can_edit   boolean     NOT NULL DEFAULT false,
  -- ON DELETE SET NULL matches projects.created_by: removing the granting
  -- admin's account must not block deletion or take the grant down with it.
  granted_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_access_module_check
    CHECK (module IN ('daily_reports','drawings','schedule','rfis')),
  CONSTRAINT project_access_user_project_module_key
    UNIQUE (user_id, project_id, module)
);

-- (user_id) is technically covered by the unique index's leading column;
-- kept per ADR-020 spec — harmless and self-documenting.
CREATE INDEX IF NOT EXISTS idx_project_access_user    ON public.project_access (user_id);
CREATE INDEX IF NOT EXISTS idx_project_access_project ON public.project_access (project_id);
-- House pattern: company_id index backing the RLS-scoped scans.
CREATE INDEX IF NOT EXISTS idx_project_access_company ON public.project_access (company_id);

-- ----------------------------------------------------------------------------
-- RLS — company-scoped reads, admin-only writes (the company_invites shape),
-- plus the standard restrictive NOT is_demo_user() on all three writes
-- (mirrors equipment_items, 0040). authenticated only; no anon policy → anon
-- denied by default. Unlike the soft-deleted tables there IS a permissive
-- DELETE here: grants are admin-managed hard deletes.
-- ----------------------------------------------------------------------------
ALTER TABLE public.project_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_access_select ON public.project_access;
CREATE POLICY project_access_select ON public.project_access
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

DROP POLICY IF EXISTS project_access_insert ON public.project_access;
CREATE POLICY project_access_insert ON public.project_access
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() = 'admin');

DROP POLICY IF EXISTS project_access_update ON public.project_access;
CREATE POLICY project_access_update ON public.project_access
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'admin')
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() = 'admin');

DROP POLICY IF EXISTS project_access_delete ON public.project_access;
CREATE POLICY project_access_delete ON public.project_access
  FOR DELETE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'admin');

DROP POLICY IF EXISTS demo_readonly_no_insert ON public.project_access;
CREATE POLICY demo_readonly_no_insert ON public.project_access
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT is_demo_user());
DROP POLICY IF EXISTS demo_readonly_no_update ON public.project_access;
CREATE POLICY demo_readonly_no_update ON public.project_access
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.project_access;
CREATE POLICY demo_readonly_no_delete ON public.project_access
  AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT is_demo_user());

-- ============================================================================
-- 3 + 4. Access-check helpers — the single chokepoints the later gate
-- migration (and API routes) will call. SECURITY DEFINER so they read
-- project_access without tripping its RLS (and without recursion once these
-- appear inside other tables' policies). Same shape as get_my_role().
--
-- get_my_role() returning NULL (no profile row) falls through every branch
-- to false — an unprovisioned user has no access.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.has_project_module_access(p_project uuid, p_module text, p_write boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN get_my_role() IN ('admin','member','demo') THEN true
    WHEN get_my_role() = 'field' THEN EXISTS (
      SELECT 1 FROM public.project_access
      WHERE user_id   = auth.uid()
        AND project_id = p_project
        AND module     = p_module
        AND (NOT p_write OR can_edit)
    )
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.has_project_visibility(p_project uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN get_my_role() IN ('admin','member','demo') THEN true
    WHEN get_my_role() = 'field' THEN EXISTS (
      SELECT 1 FROM public.project_access
      WHERE user_id   = auth.uid()
        AND project_id = p_project
    )
    ELSE false
  END;
$$;

-- ============================================================================
-- 5. GRANTS — the 0029b rule, verbatim order. Supabase default privileges
-- grant EXECUTE to anon directly, so revoke-from-public alone does NOT strip
-- anon's grant; both revokes are required.
-- ============================================================================
revoke all on function public.has_project_module_access(uuid, text, boolean) from public;
revoke all on function public.has_project_module_access(uuid, text, boolean) from anon;
grant execute on function public.has_project_module_access(uuid, text, boolean) to authenticated;

revoke all on function public.has_project_visibility(uuid) from public;
revoke all on function public.has_project_visibility(uuid) from anon;
grant execute on function public.has_project_visibility(uuid) to authenticated;

-- ============================================================================
-- 6. Invite-time project grants — the invite UI stores the picked per-project
-- module grants here; the accept flow (later phase) materializes them into
-- project_access rows. Nullable, no default: NULL = not a field invite /
-- nothing picked.
-- ============================================================================
ALTER TABLE public.company_invites
  ADD COLUMN IF NOT EXISTS project_grants jsonb;

COMMIT;
