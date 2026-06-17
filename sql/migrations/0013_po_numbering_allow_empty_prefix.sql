-- Migration 0013: per-user PO numbering — allow an empty/NULL prefix end-to-end.
--
-- Context: PO numbers are sequenced PER USER. issue_po_number() reads
-- po_prefix/po_next_seq from the caller's user_profiles row (auth.uid()) and
-- increments atomically. Previously issue_po_number() raised
-- 'PO numbering not configured' when po_prefix was NULL, so a user who
-- legitimately uses NO prefix could not issue a PO at all. We now treat an empty
-- prefix as valid (bare numeric PO numbers like '1001') and require ONLY
-- po_next_seq. release_po_number() is patched to match so empty-prefix users can
-- still recycle the last issued number.
--
-- CAREFUL LANE: review-only first. Run in the Supabase SQL Editor. Behavioural
-- change to issuance — does NOT touch any existing commitments/PO rows.

-- ── issue_po_number: require only po_next_seq; coalesce a NULL prefix to '' ────
CREATE OR REPLACE FUNCTION public.issue_po_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text;
  v_seq    int;
BEGIN
  SELECT po_prefix, po_next_seq INTO v_prefix, v_seq
  FROM user_profiles
  WHERE user_id = auth.uid()
  FOR UPDATE;

  -- po_next_seq is the ONLY required field. A NULL/empty prefix is valid — the
  -- user issues bare numeric PO numbers. (Was: 'v_prefix IS NULL OR v_seq IS NULL'.)
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'PO numbering not configured for this user';
  END IF;

  UPDATE user_profiles SET po_next_seq = v_seq + 1 WHERE user_id = auth.uid();
  RETURN COALESCE(v_prefix, '') || v_seq::text;
END;
$function$;

-- ── release_po_number: mirror the empty-prefix handling ───────────────────────
-- Recycles the LAST issued number on a failed insert so the sequence doesn't
-- skip. Coalescing the prefix to '' lets empty-prefix users recycle too. With an
-- empty prefix the prefix guard (left(p_number, 0) = '') is always true, so the
-- remainder is the whole string — which may NOT be numeric for an edited PO
-- number (e.g. 'PO-2024-A'). Guard the ::int cast with a digit check so a
-- non-numeric number is simply not-recyclable rather than raising. (This also
-- hardens the pre-existing path: even a non-empty prefix could match a number
-- whose tail is non-numeric, e.g. prefix '9' + '9A'.)
CREATE OR REPLACE FUNCTION public.release_po_number(p_number text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text;
  v_seq    int;
  v_freed  int;
BEGIN
  SELECT po_prefix, po_next_seq INTO v_prefix, v_seq
  FROM user_profiles
  WHERE user_id = auth.uid()
  FOR UPDATE;

  IF v_seq IS NULL THEN
    RETURN false;
  END IF;

  v_prefix := COALESCE(v_prefix, '');

  IF left(p_number, length(v_prefix)) <> v_prefix THEN
    RETURN false;
  END IF;

  -- Only a plain-integer remainder is sequence-recyclable.
  IF substr(p_number, length(v_prefix) + 1) !~ '^\d+$' THEN
    RETURN false;
  END IF;
  v_freed := substr(p_number, length(v_prefix) + 1)::int;

  IF v_freed = v_seq - 1 THEN
    UPDATE user_profiles SET po_next_seq = v_seq - 1 WHERE user_id = auth.uid();
    RETURN true;
  END IF;

  RETURN false;
END;
$function$;
