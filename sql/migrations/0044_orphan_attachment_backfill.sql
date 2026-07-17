-- ─────────────────────────────────────────────────────────────────────────
-- 0044: orphan-attachment R0 backfill
--   (renumbered from 0043 — that number was already taken by
--    0043_fulfilled_by_other.sql, merged in #126 and run in prod)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
-- Files uploaded through /api/upload (src/app/api/upload/route.ts) write
-- submittals.storage_path DIRECTLY and never call add_submittal_attachment,
-- so those rows carry a PDF with ZERO rows in submittal_attachments.
--
-- On such a row, add_submittal_attachment's live body sets
--   v_should_be_current := true   (unconditionally, when no is_current row exists)
-- and the sync_submittal_from_current_attachment trigger then OVERWRITES
-- submittals.storage_path from the new current attachment. The original,
-- attachment-less file is left orphaned in storage with no row pointing at
-- it — silent loss of the first-uploaded document the moment a revision lands.
--
-- Verified against prod (klgxjkapomdlbqihprwa) this session:
--   626 live submittals · 115 with a non-null storage_path ·
--   of those 115, 74 have ZERO submittal_attachments rows, 41 have >= 1.
-- This migration synthesizes ONE R0 floor row per orphaned submittal so the
-- revision stack has a real base to stack onto and the original file is
-- referenced by a row that the trigger will keep in sync.
--
-- ADDITIVE ONLY. Inserts submittal_attachments rows. Touches nothing on
-- submittals (no storage_path / file_name / title / description /
-- review_status mutation). Adds no constraints.
--
-- Scope (EXACTLY the orphaned set — the 74):
--   storage_path IS NOT NULL
--   AND status IS DISTINCT FROM 'deleted'
--   AND NOT EXISTS (an attachment row for this submittal)
-- The 41 that already have attachments are deliberately untouched: each
-- already owns an is_current row, and a second is_current would collide with
-- the partial unique index submittal_attachments_one_current_per_submittal.
--
-- Column mapping is copied VERBATIM from the canonical backfill in
-- sql/submittal-attachments-migration.sql (section 5) and its submitted_date
-- amendment in sql/submittal-attachments-add-submitted-date.sql, so the
-- submittals -> submittal_attachments column names below are the same ones
-- those proven migrations used. In particular:
--   attachment.approval_date   <- submittals.returned_from_ae_date
--   attachment.submitted_date  <- submittals.sent_to_ae_date
-- (submittals has NO approval_date / submitted_date columns of its own.)
--
-- Deviations from the canonical backfill, per task spec:
--   * revision_label is forced to 'R0' (not parsed from the filename) — every
--     synthesized floor is R0, which regexp_match parses to 0 so any later
--     R1+ correctly wins.
--   * source is 'backfill_r0' (distinguishable from bulk_import / manual in
--     any later audit).
--   * file_sha256 is copied from the parent (submittals.file_sha256). The R0
--     floor therefore carries the original file's real hash, which arms
--     add_submittal_attachment's same-bytes idempotency guard (keyed
--     submittal_id + file_sha256 + revision_label): a later re-upload of the
--     identical original returns the existing R0 row rather than stacking a
--     redundant revision. Verified against prod: 73 of the 74 orphans carry a
--     real file_sha256. The single null-sha row degrades safely — the guard is
--     gated on p_file_sha256 IS NOT NULL and simply won't fire for it, which is
--     today's behavior anyway. (We still do not HASH storage objects in this
--     migration; we only copy the hash the upload route already recorded.)
--
-- IDEMPOTENT: the WHERE NOT EXISTS guard in the SELECT means a second run
-- inserts 0 rows and the assertion below still passes. Re-running changes
-- nothing.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO submittal_attachments (
  submittal_id,
  company_id,
  storage_path,
  file_name,
  file_size,
  mime_type,
  revision_label,
  is_current,
  approval_date,
  submitted_date,
  review_status,
  submittal_number,
  uploaded_by,
  uploaded_at,
  source,
  file_sha256
)
SELECT
  s.id,
  s.company_id,
  s.storage_path,
  s.file_name,
  s.file_size,
  COALESCE(s.mime_type, 'application/pdf'),
  'R0',
  true,
  s.returned_from_ae_date,                 -- -> approval_date
  s.sent_to_ae_date,                       -- -> submitted_date
  s.review_status,
  s.submittal_number,
  s.uploaded_by,
  COALESCE(s.received_at, s.created_at),    -- -> uploaded_at (truthful chronology)
  'backfill_r0',
  s.file_sha256                             -- -> file_sha256 (real parent hash; arms the idempotency guard)
FROM submittals s
WHERE s.storage_path IS NOT NULL
  AND s.status IS DISTINCT FROM 'deleted'
  AND NOT EXISTS (
    SELECT 1
    FROM submittal_attachments a
    WHERE a.submittal_id = s.id
  );

-- Row-count assertion: after the insert, NO submittal matching the orphan
-- predicate may remain. If any does, something in the mapping silently
-- dropped a row (e.g. a NOT NULL column we didn't populate) — RAISE to roll
-- the whole transaction back rather than land a partial backfill.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*)
    INTO remaining
  FROM submittals s
  WHERE s.storage_path IS NOT NULL
    AND s.status IS DISTINCT FROM 'deleted'
    AND NOT EXISTS (
      SELECT 1
      FROM submittal_attachments a
      WHERE a.submittal_id = s.id
    );

  IF remaining <> 0 THEN
    RAISE EXCEPTION
      'orphan backfill incomplete: % submittal(s) still have storage_path but no attachment row — rolling back',
      remaining;
  END IF;
END $$;

COMMIT;
