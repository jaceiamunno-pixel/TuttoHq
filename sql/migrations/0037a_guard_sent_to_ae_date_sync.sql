-- 0037a: stop the attachment-sync trigger from erasing a stamped send date
--
-- sync_submittal_from_current_attachment() wrote:
--     sent_to_ae_date = NEW.submitted_date
-- unconditionally. submitted_date is nullable (bulk import passes
-- `submitted_date: r.submittedDate || null`), so committing a revision with no
-- submitted date NULLed the parent's sent_to_ae_date.
--
-- Since the transmittal-package work, sent_to_ae_date is STAMPED when a PM
-- sends a package to the CM / A/E. An ordinary "upload a revision, leave
-- submitted date blank" silently erased it.
--
-- Fix: COALESCE. A real submitted_date still WINS (new revision = new send
-- cycle), but a NULL no longer erases an existing value.
--
-- Scope: sent_to_ae_date ONLY. returned_from_ae_date stays a straight
-- assignment (a new revision is not yet approved). sent_to_sub_date is not
-- touched by this trigger.
--
-- CREATE OR REPLACE. Trigger definition unchanged. SECURITY DEFINER and
-- search_path preserved. Idempotent.

CREATE OR REPLACE FUNCTION public.sync_submittal_from_current_attachment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_current = true THEN
    UPDATE submittals SET
      storage_path          = NEW.storage_path,
      file_size             = NEW.file_size,
      mime_type             = NEW.mime_type,
      file_sha256           = NEW.file_sha256,
      returned_from_ae_date = NEW.approval_date,
      -- Guarded: a NULL submitted_date must not erase a stamped send date.
      sent_to_ae_date       = COALESCE(NEW.submitted_date, submittals.sent_to_ae_date),
      submittal_number      = NEW.submittal_number,
      revision_number       = NEW.revision_label,
      review_status         = NEW.review_status,
      received_at           = NEW.uploaded_at
    WHERE id = NEW.submittal_id;
  END IF;
  RETURN NEW;
END $function$;
