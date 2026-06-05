-- ─────────────────────────────────────────────────────────────────────────
-- Migration: same-bytes idempotency guard on add_submittal_attachment
-- ─────────────────────────────────────────────────────────────────────────
--
-- Closes the historical "double-commit" bug. Without this guard, calling
-- the commit route twice against the same target with the same file
-- produced two attachment rows (the 13 same-submittal pairs found by
-- the diagnose-dupe-clusters scan).
--
-- IDEMPOTENCY KEY: (submittal_id, file_sha256, revision_label).
--   - same submittal + same bytes + same revision label → NO-OP, returns
--     the existing attachment. The caller's storage.copy already ran;
--     the route detects the no-op by storage_path mismatch and cleans
--     the orphan.
--   - same submittal + same bytes + DIFFERENT revision label → ALLOWED.
--     Captures the pathological-but-legal case where a GC relabels an
--     identical-bytes re-issue. The newest-wins ordering still picks
--     the correct current revision.
--   - same bytes + DIFFERENT submittal → ALLOWED. Cross-submittal reuse
--     (library shelf + a project copy, same datasheet on two projects)
--     stays legal. The /api/check-duplicate UI badge is the warn-only
--     surface; the server doesn't block.
--
-- Idempotent migration: DROP+CREATE OR REPLACE. Re-running is a no-op.

DROP FUNCTION IF EXISTS add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text, date, text);

CREATE OR REPLACE FUNCTION add_submittal_attachment(
  p_submittal_id      uuid,
  p_storage_path      text,
  p_file_name         text,
  p_file_size         bigint,
  p_revision_label    text,
  p_approval_date     date,
  p_review_status     text,
  p_submittal_number  text,
  p_source            text DEFAULT 'bulk_import',
  p_submitted_date    date DEFAULT NULL,
  p_file_sha256       text DEFAULT NULL
)
RETURNS submittal_attachments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company_id        uuid;
  v_caller_company_id uuid;
  v_existing          submittal_attachments;
  v_new_rev_num       int;
  v_existing_rev_num  int;
  v_should_be_current boolean;
  v_attachment        submittal_attachments;
BEGIN
  v_caller_company_id := get_my_company_id();
  IF v_caller_company_id IS NULL THEN
    RAISE EXCEPTION 'no company association for caller';
  END IF;

  SELECT company_id INTO v_company_id
    FROM submittals
    WHERE id = p_submittal_id
      AND company_id = v_caller_company_id
      AND status <> 'deleted';
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'submittal not found or not accessible';
  END IF;

  -- ★ Same-bytes idempotency guard. Keyed (submittal_id, file_sha256,
  -- ★ revision_label). If an attachment for this submittal already
  -- ★ carries identical bytes UNDER THE SAME REVISION LABEL, this is
  -- ★ a re-commit (e.g. user re-ran bulk-import). Return the existing
  -- ★ row, do NOT insert a duplicate. The route detects the no-op by
  -- ★ comparing the returned row's storage_path against the path it
  -- ★ just promoted, and deletes the orphaned uploads/ object.
  -- ★
  -- ★ Different revision_label with same bytes → falls through to the
  -- ★ normal INSERT below (preserves the user's intent to record a
  -- ★ relabel even when the GC happened to re-attach identical bytes).
  -- ★ Different bytes → always falls through (no guard, normal INSERT).
  -- ★ Different submittal_id → always falls through (cross-submittal
  -- ★ reuse is legal — the UI badge is the warning surface).
  IF p_file_sha256 IS NOT NULL THEN
    SELECT * INTO v_attachment
      FROM submittal_attachments
      WHERE submittal_id   = p_submittal_id
        AND file_sha256    = p_file_sha256
        AND revision_label = p_revision_label
      ORDER BY is_current DESC, uploaded_at DESC
      LIMIT 1;
    IF v_attachment.id IS NOT NULL THEN
      RETURN v_attachment;
    END IF;
  END IF;

  v_new_rev_num := COALESCE(
    NULLIF((regexp_match(COALESCE(p_revision_label, ''), '\d+'))[1], '')::int,
    0
  );

  SELECT * INTO v_existing
    FROM submittal_attachments
    WHERE submittal_id = p_submittal_id AND is_current = true
    LIMIT 1;

  IF v_existing.id IS NULL THEN
    v_should_be_current := true;
  ELSE
    v_existing_rev_num := COALESCE(
      NULLIF((regexp_match(COALESCE(v_existing.revision_label, ''), '\d+'))[1], '')::int,
      0
    );

    IF v_new_rev_num > v_existing_rev_num THEN
      v_should_be_current := true;
    ELSIF v_new_rev_num < v_existing_rev_num THEN
      v_should_be_current := false;
    ELSE
      v_should_be_current :=
        (p_approval_date IS NOT NULL
         AND (v_existing.approval_date IS NULL OR p_approval_date > v_existing.approval_date));
    END IF;
  END IF;

  IF v_should_be_current AND v_existing.id IS NOT NULL THEN
    UPDATE submittal_attachments
      SET is_current = false
      WHERE id = v_existing.id;
  END IF;

  INSERT INTO submittal_attachments(
    submittal_id, company_id, storage_path, file_name, file_size,
    revision_label, is_current,
    approval_date, submitted_date, review_status, submittal_number,
    file_sha256,
    uploaded_by, source
  ) VALUES (
    p_submittal_id, v_company_id, p_storage_path, p_file_name, p_file_size,
    p_revision_label, v_should_be_current,
    p_approval_date, p_submitted_date, p_review_status, p_submittal_number,
    p_file_sha256,
    auth.uid(), COALESCE(p_source, 'bulk_import')
  )
  RETURNING * INTO v_attachment;

  RETURN v_attachment;
END $$;

REVOKE EXECUTE ON FUNCTION add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text, date, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text, date, text) TO authenticated;
