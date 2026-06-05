-- ─────────────────────────────────────────────────────────────────────────
-- Migration: SHA-256 file hashing for exact-duplicate detection (Part C)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Stores SHA-256 of file bytes on submittal_attachments (where the file
-- actually lives, per revision) and denormalizes the current attachment's
-- hash to submittals.file_sha256 via the existing sync trigger.
--
-- WHY BOTH TABLES: direct Library uploads write submittals.storage_path
-- directly via /api/upload and don't always have a paired
-- submittal_attachments row immediately. Storing the hash on submittals
-- lets the dupe-check query work uniformly across both paths.
--
-- WHAT THE HASH POWERS:
--   1. UPLOAD-TIME WARN: before a row is stored, check if the same hash
--      already exists in the same company + same project. If so, the UI
--      warns and lets the user confirm-or-cancel (warn-don't-block).
--   2. CROSS-PROJECT INFO: same-company different-project hash matches
--      surface as a soft note, not a blocker — re-using the same product
--      datasheet across jobs is legitimate.
--   3. BACKFILL: a read-only one-time script computes the hash for every
--      existing row's storage object and reports the dupe clusters.
--      Cleanup/delete is a separate careful-lane action after review.
--
-- WHAT THE HASH DOES NOT DO:
--   - It does NOT silently block writes.
--   - It does NOT silently overwrite existing rows.
--   - It does NOT trigger automatic cleanup or deletes of any kind.
--
-- INDEX strategy: composite (company_id, file_sha256) on both tables
-- with a partial WHERE-NOT-NULL clause. The dupe check joins to projects
-- in the API layer for project-name display.
--
-- Idempotent. Re-running is a no-op.

-- ── 1. Columns ──────────────────────────────────────────────────────────
ALTER TABLE submittal_attachments
  ADD COLUMN IF NOT EXISTS file_sha256 text;

ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS file_sha256 text;

-- ── 2. Indexes — fast same-company hash lookups ─────────────────────────
CREATE INDEX IF NOT EXISTS submittal_attachments_sha256_lookup_idx
  ON submittal_attachments(company_id, file_sha256)
  WHERE file_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS submittals_sha256_lookup_idx
  ON submittals(company_id, file_sha256)
  WHERE file_sha256 IS NOT NULL AND status <> 'deleted';

-- ── 3. Sync trigger — propagate file_sha256 (current attachment → parent)
--     Existing trigger already mirrors storage_path / file_size / etc.;
--     we extend it to also mirror file_sha256 so a direct query against
--     submittals.file_sha256 always reflects the current revision.
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
      file_sha256           = NEW.file_sha256,
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

DROP TRIGGER IF EXISTS submittal_attachments_sync_current_aiu ON submittal_attachments;
CREATE TRIGGER submittal_attachments_sync_current_aiu
AFTER INSERT OR UPDATE OF
  is_current, storage_path, file_size, mime_type, file_sha256,
  approval_date, submitted_date,
  review_status, submittal_number, revision_label, uploaded_at
ON submittal_attachments
FOR EACH ROW EXECUTE FUNCTION sync_submittal_from_current_attachment();

-- ── 4. RPC: add_submittal_attachment now accepts p_file_sha256 ──────────
--     Backward-compatible (DEFAULT NULL). Old callers continue to work
--     through the deploy; the bulk-import commit route updates to pass
--     the hash in the same release.
DROP FUNCTION IF EXISTS add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text, date);

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
