-- ─────────────────────────────────────────────────────────────────────────
-- Trigger fix: stop renaming log rows on attachment commit
-- ─────────────────────────────────────────────────────────────────────────
--
-- The original sync_submittal_from_current_attachment() trigger (shipped
-- in the submittal_attachments migration) writes the new attachment's
-- file_name + received_file_name onto the parent submittals row. That's
-- wrong: the title/description belongs to the LOG ROW's spec-book
-- identity (the row was created from a spec-book item like "Ceramic
-- Tile"), and the attachment provides the PDF + per-revision metadata.
-- Renaming the row on commit destroys the spec-book title.
--
-- This migration uses CREATE OR REPLACE so the trigger DEFINITION stays
-- (no DROP/recreate needed). Idempotent.
--
-- KEEP propagating to submittals (per-revision data legitimately reflects
-- the current revision):
--   storage_path          — clicking the row opens the current PDF
--   file_size, mime_type  — same row of metadata
--   returned_from_ae_date — architect approval date for current rev
--   submittal_number      — GC submittal # for current rev
--   revision_number       — current revision label (R1/R2/…)
--   review_status         — review outcome for current rev
--   received_at           — when current rev landed in the log
--
-- STOP propagating (these are SPEC-BOOK identity, frozen at row creation):
--   file_name             — the row's title/description
--   received_file_name    — same; was a duplicate of file_name
-- ─────────────────────────────────────────────────────────────────────────

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
      -- file_name and received_file_name INTENTIONALLY NOT updated —
      -- the row's title belongs to its spec-book identity. The
      -- attachment row still stores its own file_name (visible in the
      -- revision slide-out as the per-revision filename).
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

-- Trigger ITSELF unchanged — only the function it calls was updated.
-- No need to DROP/CREATE the trigger; the AFTER INSERT OR UPDATE binding
-- from the original migration still applies and picks up the new
-- function body on the next fire.
