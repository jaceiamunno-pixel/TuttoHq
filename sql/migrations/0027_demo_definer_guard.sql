-- ==========================================================================
-- 0027_demo_definer_guard.sql
-- ==========================================================================
-- Closes the SECURITY DEFINER hole left by 0026: definer functions BYPASS RLS,
-- so a demo user (role='demo') reaching a write-performing definer RPC from the
-- app could mutate the shared demo company's data despite 0026's RESTRICTIVE
-- write-block. This adds a demo write-block at the TOP of every such RPC.
--
-- Depends on 0026 (public.is_demo_user(), companies.is_demo). 0026 is APPLIED.
-- Numbered 0027 (next free; 0026 applied). Additive; does not touch RLS/storage.
--
-- GUARDED (15): writes + reachable by an authenticated demo user via normal UI.
--   3 plpgsql  -> inline  IF public.is_demo_user() THEN RAISE 42501; END IF;
--   12 sql     -> leading SELECT public.assert_not_demo();  (sql cannot host IF/RAISE)
-- assert_not_demo() raises the SAME error/errcode. Proven (rolled-back, live DB):
-- a leading SELECT assert_not_demo() in a LANGUAGE sql fn raises 42501 BEFORE the
-- write statement runs; target row stays unchanged. Each body is re-emitted from
-- pg_get_functiondef verbatim (signature/return/volatility/SECURITY DEFINER/
-- search_path preserved) with ONLY the guard added.
--
-- NOT GUARDED (deliberate):
--   accept_invite_link, remove_user_from_company, set_user_role — admin/role-gated;
--     a role='demo' user can't reach their write branch, and they return structured
--     (success,error_code) rather than raising.
--   sync_submittal_from_current_attachment — TRIGGER, not directly callable; fires
--     only on a submittal_attachments write that 0026 already blocks for demo.
--   (pure-SELECT definer fns: get_my_*, get_invite_by_token, list_deleted_* — no write.)
-- ------------------------------------------------------------------------

BEGIN;

-- ==========================================================================
-- 1. assert_not_demo() — raises 42501 for demo users (used by the 12 sql RPCs)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.assert_not_demo()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.is_demo_user() THEN
    RAISE EXCEPTION 'demo tenant is read-only' USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- ==========================================================================
-- 2. plpgsql RPCs (3) — inline IF/RAISE guard at top of body; bodies otherwise unchanged
-- ==========================================================================
-- issue_po_number()
CREATE OR REPLACE FUNCTION public.issue_po_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_prefix text; v_seq int;
BEGIN
  IF public.is_demo_user() THEN
    RAISE EXCEPTION 'demo tenant is read-only' USING ERRCODE = '42501';
  END IF;
  SELECT po_prefix, po_next_seq INTO v_prefix, v_seq
  FROM user_profiles WHERE user_id = auth.uid() FOR UPDATE;
  IF v_seq IS NULL THEN                          -- was: v_prefix IS NULL OR v_seq IS NULL
    RAISE EXCEPTION 'PO numbering not configured for this user';
  END IF;
  UPDATE user_profiles SET po_next_seq = v_seq + 1 WHERE user_id = auth.uid();
  RETURN COALESCE(v_prefix, '') || v_seq::text;   -- was: v_prefix || v_seq::text
END; $function$;

-- release_po_number(p_number text)
CREATE OR REPLACE FUNCTION public.release_po_number(p_number text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_prefix text; v_seq int; v_freed int;
BEGIN
  IF public.is_demo_user() THEN
    RAISE EXCEPTION 'demo tenant is read-only' USING ERRCODE = '42501';
  END IF;
  SELECT po_prefix, po_next_seq INTO v_prefix, v_seq
  FROM user_profiles WHERE user_id = auth.uid() FOR UPDATE;
  IF v_seq IS NULL THEN RETURN false; END IF;
  v_prefix := COALESCE(v_prefix, '');             -- was: IF v_prefix IS NULL THEN RETURN false
  IF left(p_number, length(v_prefix)) <> v_prefix THEN RETURN false; END IF;
  IF substr(p_number, length(v_prefix) + 1) !~ '^\d+$' THEN RETURN false; END IF;  -- NEW guard
  v_freed := substr(p_number, length(v_prefix) + 1)::int;
  IF v_freed = v_seq - 1 THEN
    UPDATE user_profiles SET po_next_seq = v_seq - 1 WHERE user_id = auth.uid();
    RETURN true;
  END IF;
  RETURN false;
END; $function$;

-- soft_delete_drawing_revision(p_id uuid, p_new_current uuid)
CREATE OR REPLACE FUNCTION public.soft_delete_drawing_revision(p_id uuid, p_new_current uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_sheet uuid; v_co uuid;
BEGIN
  IF public.is_demo_user() THEN
    RAISE EXCEPTION 'demo tenant is read-only' USING ERRCODE = '42501';
  END IF;
  SELECT sheet_id INTO v_sheet FROM public.drawing_revisions
    WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL;
  IF v_sheet IS NULL THEN RETURN NULL; END IF;

  IF p_new_current IS NOT NULL THEN
    -- re-point current first; verify the target is a live, same-company, same-sheet, non-markup row
    PERFORM 1 FROM public.drawing_revisions
      WHERE id = p_new_current AND sheet_id = v_sheet
        AND company_id = get_my_company_id() AND deleted_at IS NULL AND source <> 'markup';
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid re-point target'; END IF;
    UPDATE public.drawing_sheets SET current_revision_id = p_new_current
      WHERE id = v_sheet AND company_id = get_my_company_id();
  END IF;

  UPDATE public.drawing_revisions SET deleted_at = now() WHERE id = p_id;
  RETURN p_id;
END;
$function$;

-- ==========================================================================
-- 3. LANGUAGE sql RPCs (12) — leading SELECT public.assert_not_demo(); bodies otherwise unchanged
-- ==========================================================================
-- restore_drawing_revision(p_id uuid)
CREATE OR REPLACE FUNCTION public.restore_drawing_revision(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.drawing_revisions SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$function$;

-- restore_drawing_sheet(p_id uuid)
CREATE OR REPLACE FUNCTION public.restore_drawing_sheet(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.drawing_sheets SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$function$;

-- restore_manpower_assignment(p_id uuid)
CREATE OR REPLACE FUNCTION public.restore_manpower_assignment(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.manpower_assignments SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$function$;

-- restore_project(p_id uuid)
CREATE OR REPLACE FUNCTION public.restore_project(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.projects SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$function$;

-- restore_schedule_task(p_id uuid)
CREATE OR REPLACE FUNCTION public.restore_schedule_task(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.schedule_tasks SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$function$;

-- restore_worker(p_id uuid)
CREATE OR REPLACE FUNCTION public.restore_worker(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.workers SET deleted_at = NULL
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
  RETURNING id;
$function$;

-- soft_delete_drawing_sheet(p_id uuid)
CREATE OR REPLACE FUNCTION public.soft_delete_drawing_sheet(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.drawing_sheets SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$function$;

-- soft_delete_manpower_assignment(p_id uuid)
CREATE OR REPLACE FUNCTION public.soft_delete_manpower_assignment(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.manpower_assignments SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$function$;

-- soft_delete_project(p_id uuid)
CREATE OR REPLACE FUNCTION public.soft_delete_project(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.projects SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$function$;

-- soft_delete_schedule_task(p_id uuid)
CREATE OR REPLACE FUNCTION public.soft_delete_schedule_task(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.schedule_tasks SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$function$;

-- soft_delete_worker(p_id uuid)
CREATE OR REPLACE FUNCTION public.soft_delete_worker(p_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE public.workers SET deleted_at = now()
  WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
  RETURNING id;
$function$;

-- set_my_signature(p_path text)
CREATE OR REPLACE FUNCTION public.set_my_signature(p_path text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.assert_not_demo();
  UPDATE user_profiles
  SET signature_storage_path = p_path
  WHERE user_id = auth.uid();
$function$;

COMMIT;

-- ==========================================================================
-- VERIFICATION (run after COMMIT, as owner) — confirm each guarded fn shows the guard
-- ==========================================================================
-- SELECT proname,
--        (pg_get_functiondef(p.oid) LIKE '%assert_not_demo%'
--         OR pg_get_functiondef(p.oid) LIKE '%demo tenant is read-only%') AS has_guard
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname='public' AND p.proname IN (
--   'issue_po_number','release_po_number','soft_delete_drawing_revision',
--   'restore_drawing_revision','restore_drawing_sheet','restore_manpower_assignment',
--   'restore_project','restore_schedule_task','restore_worker',
--   'soft_delete_drawing_sheet','soft_delete_manpower_assignment','soft_delete_project',
--   'soft_delete_schedule_task','soft_delete_worker','set_my_signature')
-- ORDER BY 1;   -- expect has_guard = true for all 15

-- ==========================================================================
-- ROLLBACK (down-path) — restore original un-guarded bodies, then drop helper
-- ==========================================================================
-- BEGIN;
--   -- issue_po_number
--   CREATE OR REPLACE FUNCTION public.issue_po_number()
--    RETURNS text
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE v_prefix text; v_seq int;
--   BEGIN
--     SELECT po_prefix, po_next_seq INTO v_prefix, v_seq
--     FROM user_profiles WHERE user_id = auth.uid() FOR UPDATE;
--     IF v_seq IS NULL THEN                          -- was: v_prefix IS NULL OR v_seq IS NULL
--       RAISE EXCEPTION 'PO numbering not configured for this user';
--     END IF;
--     UPDATE user_profiles SET po_next_seq = v_seq + 1 WHERE user_id = auth.uid();
--     RETURN COALESCE(v_prefix, '') || v_seq::text;   -- was: v_prefix || v_seq::text
--   END; $function$;
--
--   -- release_po_number
--   CREATE OR REPLACE FUNCTION public.release_po_number(p_number text)
--    RETURNS boolean
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE v_prefix text; v_seq int; v_freed int;
--   BEGIN
--     SELECT po_prefix, po_next_seq INTO v_prefix, v_seq
--     FROM user_profiles WHERE user_id = auth.uid() FOR UPDATE;
--     IF v_seq IS NULL THEN RETURN false; END IF;
--     v_prefix := COALESCE(v_prefix, '');             -- was: IF v_prefix IS NULL THEN RETURN false
--     IF left(p_number, length(v_prefix)) <> v_prefix THEN RETURN false; END IF;
--     IF substr(p_number, length(v_prefix) + 1) !~ '^\d+$' THEN RETURN false; END IF;  -- NEW guard
--     v_freed := substr(p_number, length(v_prefix) + 1)::int;
--     IF v_freed = v_seq - 1 THEN
--       UPDATE user_profiles SET po_next_seq = v_seq - 1 WHERE user_id = auth.uid();
--       RETURN true;
--     END IF;
--     RETURN false;
--   END; $function$;
--
--   -- soft_delete_drawing_revision
--   CREATE OR REPLACE FUNCTION public.soft_delete_drawing_revision(p_id uuid, p_new_current uuid)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE v_sheet uuid; v_co uuid;
--   BEGIN
--     SELECT sheet_id INTO v_sheet FROM public.drawing_revisions
--       WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL;
--     IF v_sheet IS NULL THEN RETURN NULL; END IF;
--
--     IF p_new_current IS NOT NULL THEN
--       -- re-point current first; verify the target is a live, same-company, same-sheet, non-markup row
--       PERFORM 1 FROM public.drawing_revisions
--         WHERE id = p_new_current AND sheet_id = v_sheet
--           AND company_id = get_my_company_id() AND deleted_at IS NULL AND source <> 'markup';
--       IF NOT FOUND THEN RAISE EXCEPTION 'invalid re-point target'; END IF;
--       UPDATE public.drawing_sheets SET current_revision_id = p_new_current
--         WHERE id = v_sheet AND company_id = get_my_company_id();
--     END IF;
--
--     UPDATE public.drawing_revisions SET deleted_at = now() WHERE id = p_id;
--     RETURN p_id;
--   END;
--   $function$;
--
--   -- restore_drawing_revision
--   CREATE OR REPLACE FUNCTION public.restore_drawing_revision(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.drawing_revisions SET deleted_at = NULL
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
--     RETURNING id;
--   $function$;
--
--   -- restore_drawing_sheet
--   CREATE OR REPLACE FUNCTION public.restore_drawing_sheet(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.drawing_sheets SET deleted_at = NULL
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
--     RETURNING id;
--   $function$;
--
--   -- restore_manpower_assignment
--   CREATE OR REPLACE FUNCTION public.restore_manpower_assignment(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.manpower_assignments SET deleted_at = NULL
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
--     RETURNING id;
--   $function$;
--
--   -- restore_project
--   CREATE OR REPLACE FUNCTION public.restore_project(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.projects SET deleted_at = NULL
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
--     RETURNING id;
--   $function$;
--
--   -- restore_schedule_task
--   CREATE OR REPLACE FUNCTION public.restore_schedule_task(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.schedule_tasks SET deleted_at = NULL
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
--     RETURNING id;
--   $function$;
--
--   -- restore_worker
--   CREATE OR REPLACE FUNCTION public.restore_worker(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.workers SET deleted_at = NULL
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NOT NULL
--     RETURNING id;
--   $function$;
--
--   -- soft_delete_drawing_sheet
--   CREATE OR REPLACE FUNCTION public.soft_delete_drawing_sheet(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.drawing_sheets SET deleted_at = now()
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
--     RETURNING id;
--   $function$;
--
--   -- soft_delete_manpower_assignment
--   CREATE OR REPLACE FUNCTION public.soft_delete_manpower_assignment(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.manpower_assignments SET deleted_at = now()
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
--     RETURNING id;
--   $function$;
--
--   -- soft_delete_project
--   CREATE OR REPLACE FUNCTION public.soft_delete_project(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.projects SET deleted_at = now()
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
--     RETURNING id;
--   $function$;
--
--   -- soft_delete_schedule_task
--   CREATE OR REPLACE FUNCTION public.soft_delete_schedule_task(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.schedule_tasks SET deleted_at = now()
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
--     RETURNING id;
--   $function$;
--
--   -- soft_delete_worker
--   CREATE OR REPLACE FUNCTION public.soft_delete_worker(p_id uuid)
--    RETURNS uuid
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE public.workers SET deleted_at = now()
--     WHERE id = p_id AND company_id = get_my_company_id() AND deleted_at IS NULL
--     RETURNING id;
--   $function$;
--
--   -- set_my_signature
--   CREATE OR REPLACE FUNCTION public.set_my_signature(p_path text)
--    RETURNS void
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     UPDATE user_profiles
--     SET signature_storage_path = p_path
--     WHERE user_id = auth.uid();
--   $function$;
--
--   DROP FUNCTION IF EXISTS public.assert_not_demo();
-- COMMIT;
