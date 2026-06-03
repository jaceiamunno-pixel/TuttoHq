-- ─────────────────────────────────────────────────────────────────────────
-- Migration: submittal_attachments (revision grouping)
-- ─────────────────────────────────────────────────────────────────────────
--
-- A log row (submittals) now holds ONE OR MORE PDF revisions
-- (submittal_attachments). The "current" attachment is the one displayed
-- by default; it's the NEWEST revision by label (R0 < R1 < R2 < …) with
-- approval_date as tiebreaker, NOT insertion order — R3 committed before
-- R2 still ends up with R3 as current.
--
-- submittals' denormalized PDF columns (storage_path, file_name,
-- returned_from_ae_date, …) stay as a snapshot of the current attachment,
-- maintained by a trigger so existing code that reads those columns
-- (Library view, transmittal PDFs, gmail intake, …) keeps working
-- unchanged. The change is additive — no submittals columns dropped.
--
-- Idempotent: the table-creation uses IF NOT EXISTS, the backfill uses
-- WHERE NOT EXISTS, so running twice is a no-op.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── 1. Attachments table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submittal_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submittal_id    uuid NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,

  -- Denormalized so the RLS policy doesn't have to join — required to
  -- match the parent submittal's company_id; the RPC verifies this and
  -- the trigger guarantees it stays in sync.
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- The PDF
  storage_path    text   NOT NULL,
  file_name       text   NOT NULL,
  file_size       bigint,
  mime_type       text   DEFAULT 'application/pdf',

  -- Revision identity — display label, free text. Numeric comparison
  -- for newest-wins uses (regexp_match(label, '\d+'))[1]::int with
  -- COALESCE-to-0 for non-numeric labels.
  revision_label  text   NOT NULL,

  -- At most one current attachment per submittal_id (partial unique
  -- index below). The RPC unsets the previous current in the same
  -- transaction as inserting the new one.
  is_current      boolean NOT NULL DEFAULT false,

  -- Per-revision metadata (each revision has its OWN approval date /
  -- review status / GC submittal #)
  approval_date     date,
  review_status     text,
  submittal_number  text,

  -- Provenance
  uploaded_by     uuid REFERENCES auth.users(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'bulk_import'
);

CREATE UNIQUE INDEX IF NOT EXISTS submittal_attachments_one_current_per_submittal
  ON submittal_attachments(submittal_id) WHERE is_current = true;

CREATE INDEX IF NOT EXISTS submittal_attachments_submittal_id_idx ON submittal_attachments(submittal_id);
CREATE INDEX IF NOT EXISTS submittal_attachments_company_id_idx   ON submittal_attachments(company_id);
CREATE INDEX IF NOT EXISTS submittal_attachments_storage_path_idx ON submittal_attachments(storage_path);
CREATE INDEX IF NOT EXISTS submittal_attachments_uploaded_at_idx  ON submittal_attachments(uploaded_at DESC);

-- ─── 2. RLS ──────────────────────────────────────────────────────────────
ALTER TABLE submittal_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "submittal_attachments_select" ON submittal_attachments;
CREATE POLICY "submittal_attachments_select"
  ON submittal_attachments FOR SELECT
  USING (company_id = (SELECT get_my_company_id()));

DROP POLICY IF EXISTS "submittal_attachments_insert" ON submittal_attachments;
CREATE POLICY "submittal_attachments_insert"
  ON submittal_attachments FOR INSERT
  WITH CHECK (company_id = (SELECT get_my_company_id()));

DROP POLICY IF EXISTS "submittal_attachments_update" ON submittal_attachments;
CREATE POLICY "submittal_attachments_update"
  ON submittal_attachments FOR UPDATE
  USING (company_id = (SELECT get_my_company_id()))
  WITH CHECK (company_id = (SELECT get_my_company_id()));

DROP POLICY IF EXISTS "submittal_attachments_delete" ON submittal_attachments;
CREATE POLICY "submittal_attachments_delete"
  ON submittal_attachments FOR DELETE
  USING (company_id = (SELECT get_my_company_id()));

-- ─── 3. Trigger: keep submittals row's denormalized fields = current ────
-- Existing app code (Library, transmittal PDFs, gmail intake, RFI PDF
-- generation, …) reads submittals.storage_path / file_name /
-- returned_from_ae_date / etc. directly. We don't want to chase down
-- every caller now. The trigger keeps those columns mirrored to whatever
-- attachment is currently is_current=true.
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
      file_name             = NEW.file_name,
      received_file_name    = NEW.file_name,
      file_size             = NEW.file_size,
      mime_type             = NEW.mime_type,
      returned_from_ae_date = NEW.approval_date,
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
  is_current, storage_path, file_name, file_size, mime_type,
  approval_date, review_status, submittal_number, revision_label, uploaded_at
ON submittal_attachments
FOR EACH ROW
EXECUTE FUNCTION sync_submittal_from_current_attachment();

-- ─── 4. RPC: add_submittal_attachment (NEWEST-WINS) ──────────────────────
-- Called by the commit route. The new attachment is INSERTED regardless
-- of revision order, but is_current is set only when this revision is
-- STRICTLY NEWER than the existing current. "Newer" = higher integer
-- extracted from the revision_label (R0=0, R1=1, R2=2, …) with
-- approval_date as a tiebreaker. Out-of-order commits (R3 then R2) end
-- with the higher revision marked current — bulk import doesn't process
-- files newest-last, so the partial unique index alone wasn't enough.
--
-- SECURITY INVOKER so RLS scopes by caller's company; the explicit
-- company_id lookup also verifies they own the parent submittal.
CREATE OR REPLACE FUNCTION add_submittal_attachment(
  p_submittal_id      uuid,
  p_storage_path      text,
  p_file_name         text,
  p_file_size         bigint,
  p_revision_label    text,
  p_approval_date     date,
  p_review_status     text,
  p_submittal_number  text,
  p_source            text DEFAULT 'bulk_import'
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
  -- Tenant check: the caller's company must own the parent submittal.
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

  -- Parse the new attachment's numeric revision (R3 → 3, "Original" → 0).
  v_new_rev_num := COALESCE(
    NULLIF((regexp_match(COALESCE(p_revision_label, ''), '\d+'))[1], '')::int,
    0
  );

  -- Look up the existing current attachment, if any.
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
      -- Same revision number → newer approval_date wins. NULLs lose.
      v_should_be_current :=
        (p_approval_date IS NOT NULL
         AND (v_existing.approval_date IS NULL OR p_approval_date > v_existing.approval_date));
    END IF;
  END IF;

  -- Atomic flip: unset the previous current, then insert the new one as
  -- current. The partial unique index would block an out-of-order INSERT
  -- otherwise; we explicitly unset first when this new attachment wins.
  IF v_should_be_current AND v_existing.id IS NOT NULL THEN
    UPDATE submittal_attachments
      SET is_current = false
      WHERE id = v_existing.id;
  END IF;

  INSERT INTO submittal_attachments(
    submittal_id, company_id, storage_path, file_name, file_size,
    revision_label, is_current,
    approval_date, review_status, submittal_number,
    uploaded_by, source
  ) VALUES (
    p_submittal_id, v_company_id, p_storage_path, p_file_name, p_file_size,
    p_revision_label, v_should_be_current,
    p_approval_date, p_review_status, p_submittal_number,
    auth.uid(), COALESCE(p_source, 'bulk_import')
  )
  RETURNING * INTO v_attachment;

  RETURN v_attachment;
END $$;

REVOKE EXECUTE ON FUNCTION add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_submittal_attachment(uuid, text, text, bigint, text, date, text, text, text) TO authenticated;

-- ─── 5. BACKFILL — idempotent, tenant-correct ───────────────────────────
-- For every alive submittals row currently holding a PDF (storage_path
-- IS NOT NULL, status != 'deleted'), create one attachment marked
-- is_current=true. revision_label is parsed from the filename when it
-- carries the "Sub No NNN -R<n>" Waters convention or the older
-- "NNNNNNNN_R<n>" BAM convention; otherwise it falls back to
-- revision_number (with "00"/"0"/NULL normalized to "R0").
--
-- Idempotency: WHERE NOT EXISTS makes re-running a no-op.
-- Tenant correctness: company_id is copied verbatim from the parent
-- submittal; the trigger above guarantees subsequent updates stay in
-- sync. No cross-tenant leak path.
INSERT INTO submittal_attachments(
  submittal_id, company_id, storage_path, file_name, file_size, mime_type,
  revision_label, is_current,
  approval_date, review_status, submittal_number,
  uploaded_by, uploaded_at, source
)
SELECT
  s.id,
  s.company_id,
  s.storage_path,
  s.file_name,
  s.file_size,
  COALESCE(s.mime_type, 'application/pdf'),
  CASE
    WHEN s.file_name ~* '[ _-]Sub[ _-]+No[ _-]+\d+[ _-]+R(\d+)'
      THEN 'R' || (regexp_match(s.file_name, '[ _-]Sub[ _-]+No[ _-]+\d+[ _-]+R(\d+)', 'i'))[1]
    WHEN s.file_name ~* '\d{8}[ _-]+R(\d+)'
      THEN 'R' || (regexp_match(s.file_name, '\d{8}[ _-]+R(\d+)', 'i'))[1]
    WHEN s.revision_number IN ('00', '0') OR s.revision_number IS NULL
      THEN 'R0'
    ELSE s.revision_number
  END,
  true,
  s.returned_from_ae_date,
  s.review_status,
  s.submittal_number,
  s.uploaded_by,
  COALESCE(s.received_at, s.created_at),
  CASE
    WHEN s.source = 'spec_ingestion' THEN 'bulk_import'
    ELSE COALESCE(s.source, 'manual')
  END
FROM submittals s
WHERE s.storage_path IS NOT NULL
  AND s.status <> 'deleted'
  AND NOT EXISTS (
    SELECT 1 FROM submittal_attachments a WHERE a.submittal_id = s.id
  );
