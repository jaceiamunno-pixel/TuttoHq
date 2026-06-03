-- ─────────────────────────────────────────────────────────────────────────
-- Migration: per-revision submitted_date on submittal_attachments
-- ─────────────────────────────────────────────────────────────────────────
--
-- The Waters/THP coversheet form widget (Text4) is the GC's "Date
-- Submitted" — when the contractor sent the package for review. It is
-- NOT the architect's approval date (which lives in the PDF Stamp
-- annotation's /CreationDate on the disposition-stamp page). Previously
-- the bulk-import commit stored Text4 in submittals.returned_from_ae_date,
-- mislabeling submission as approval. The fix:
--
--   approval_date  (existing) — architect-stamp /CreationDate
--   submitted_date (NEW)      — GC's Text4 submission date
--
-- Each revision carries both — when R3 is added with a new submission +
-- new approval, both dates flow up to the parent submittals row via the
-- trigger.
--
-- Idempotent. Re-running is a no-op.

-- ── 1. Column add (additive, default NULL) ──────────────────────────────
ALTER TABLE submittal_attachments
  ADD COLUMN IF NOT EXISTS submitted_date date;

-- ── 2. Trigger function — sync submitted_date → submittals.sent_to_ae_date
--      (the existing "when sent to architect/engineer" column). Keeps
--      file_name + received_file_name out per the earlier title-freeze fix.
CREATE OR REPLACE FUNCTION sync_submittal_from_current_attachment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_current = true THEN
    UPDATE submittals SET
      storage_path          = NEW.storage_path,
      file_size             = NEW.file_size,
      mime_type             = NEW.mime_type,
      returned_from_ae_date = NEW.approval_date,
      sent_to_ae_date       = NEW.submitted_date,
      submittal_number      = NEW.submittal_number,
      revision_number       = NEW.revision_label,
      review_status         = NEW.review_status,
      received_at           = NEW.uploaded_at
    WHERE id = NEW.submittal_id;
  END IF;
  RETURN NEW;
END $$;

-- ── 3. Update trigger to watch the new column too ──────────────────────
DROP TRIGGER IF EXISTS submittal_attachments_sync_current_aiu ON submittal_attachments;
CREATE TRIGGER submittal_attachments_sync_current_aiu
AFTER INSERT OR UPDATE OF
  is_current, storage_path, file_size, mime_type,
  approval_date, submitted_date,
  review_status, submittal_number, revision_label, uploaded_at
ON submittal_attachments
FOR EACH ROW EXECUTE FUNCTION sync_submittal_from_current_attachment();

-- ── 4. RPC: add the new optional parameter (DEFAULT NULL keeps old
--      callers working until the route is updated to pass it). The
--      function signature changed, so we DROP-and-CREATE rather than
--      CREATE-OR-REPLACE.
DROP FUNCTION IF EXISTS add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text);

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
  p_submitted_date    date DEFAULT NULL
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
    uploaded_by, source
  ) VALUES (
    p_submittal_id, v_company_id, p_storage_path, p_file_name, p_file_size,
    p_revision_label, v_should_be_current,
    p_approval_date, p_submitted_date, p_review_status, p_submittal_number,
    auth.uid(), COALESCE(p_source, 'bulk_import')
  )
  RETURNING * INTO v_attachment;

  RETURN v_attachment;
END $$;

REVOKE EXECUTE ON FUNCTION add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text, date) TO authenticated;
