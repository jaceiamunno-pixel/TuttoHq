-- ─────────────────────────────────────────────────────────────────────────
-- 0046: submittals.review_status — canonical vocabulary + CHECK constraint
--   (this is the migration the Vault's 2026-07-17 SESSION UPDATE calls
--    "0042" — renumbered because 0042–0045 are taken on master)
-- ─────────────────────────────────────────────────────────────────────────
--
-- ⚠️ ORDERING IS LOAD-BEARING — RUN ONLY AFTER THE CODE DEPLOYS.
-- Pre-deploy code still writes 'Needs Review' / 'Under Review' /
-- 'Transmitted'; the CHECK below would reject those writes in prod. Deploy
-- the writer changes (this migration's sibling code PR) first, then run this.
--
-- WHY THIS EXISTS
-- review_status has no CHECK constraint (submittals.source has one;
-- review_status never did) — it is free text and drifted to 6 values, two of
-- them pure drift ('Pending', 'Review') that arrived through the unvalidated
-- PATCH /api/submittals/[id] route. The dominant value lied about workflow
-- state: 421 of 495 'Received' rows had no file and no dates.
--
-- Target vocabulary (Jace approved 2026-07-17, mirrors CM stamp language):
--   Not Started → Received → Sent to A/E
--     → Approved | Approved as Noted | Revise & Resubmit | Rejected → Closed
--
-- ONE TRANSACTION, THREE STEPS IN ORDER:
--   1. Backfill the live partition per the Vault-approved cross-tab —
--      bucket-by-bucket, never a blanket remap.
--   2. Column DEFAULT 'Received' → 'Not Started'.
--   3. Add the CHECK (validates ALL rows, soft-deleted included).
--
-- Partition gates used below (submittals has TWO soft-delete markers with
-- DIFFERENT populations — verified read-only 2026-07-17):
--   live         = status <> 'deleted' AND deleted_at IS NULL   (628 rows)
--   soft-deleted = status = 'deleted' OR deleted_at IS NOT NULL (702 rows:
--                  16 status-only + 686 deleted_at-only, 0 overlap)
-- The backfill touches ONLY the live partition. The soft-deleted partition
-- needs no backfill: all 702 rows verified in-vocab ('Received' 701,
-- 'Approved' 1), so step 3's CHECK validates over them as-is.
-- NULL review_status count is 0 everywhere, and a plain IN-list CHECK
-- passes NULL by SQL semantics anyway — no explicit NULL escape needed.
--
-- Verified bucket counts (read-only against prod, 2026-07-17 ~17:00Z).
-- NOTE: prod moved since the Vault cross-tab was snapshotted (626 → 628
-- live rows; 'Needs Review' 74 → 71). The PREDICATES are unchanged from the
-- approved cross-tab; only the counts drifted. Expected UPDATE row counts
-- as of this writing — cross-check each against the SQL Editor's output:
--   step 1a  'Received'     no file, no dates            → 'Not Started'  421
--   step 1b  'Needs Review' no file, no dates            → 'Not Started'   71
--   step 1c  'Under Review' file, to_ae only             → 'Sent to A/E'   21
--   step 1d  'Under Review' file, ret_ae (± to_ae)       → 'Approved'      13
--   step 1e  'Pending'  (drift)                          → 'Received'       3
--   step 1f  'Review'   (drift)                          → 'Received'       2
--                                                   total changed        531
-- 97 live rows keep their value ('Received' with file ×74, 'Approved' ×23).
-- Run the companion dry-run (sql/migrations/0046_dryrun.sql) first and
-- compare row-for-row.
--
-- SAFETY NET: step 2.5 is a guard that aborts the whole transaction with a
-- listing if ANY row (any partition) is still outside the vocabulary when
-- the CHECK is about to be added — e.g. a row written with old vocab between
-- this file's authoring and run time. Nothing half-applies: on abort,
-- investigate the listed values, re-run the dry-run, then re-run this file.

BEGIN;

-- ── 1. Backfill (live partition only, Vault cross-tab bucket-by-bucket) ──

-- 1a. Received / no file / no dates → Not Started  (expected 421)
-- The spec-ingestion seeder stamped placeholders 'Received' when nothing
-- had been received; those rows are workflow-untouched.
UPDATE submittals
SET review_status = 'Not Started'
WHERE status <> 'deleted' AND deleted_at IS NULL
  AND review_status = 'Received'
  AND storage_path IS NULL
  AND received_date IS NULL
  AND sent_to_ae_date IS NULL
  AND returned_from_ae_date IS NULL;

-- 1b. Needs Review / no file / no dates → Not Started  (expected 71)
-- 'Needs Review' was one seeder's alternative empty-placeholder default —
-- same workflow state as 1a, and the value leaves the vocabulary.
UPDATE submittals
SET review_status = 'Not Started'
WHERE status <> 'deleted' AND deleted_at IS NULL
  AND review_status = 'Needs Review'
  AND storage_path IS NULL
  AND received_date IS NULL
  AND sent_to_ae_date IS NULL
  AND returned_from_ae_date IS NULL;

-- 1c. Under Review / file / sent to A/E, not returned → Sent to A/E  (expected 21)
UPDATE submittals
SET review_status = 'Sent to A/E'
WHERE status <> 'deleted' AND deleted_at IS NULL
  AND review_status = 'Under Review'
  AND storage_path IS NOT NULL
  AND sent_to_ae_date IS NOT NULL
  AND returned_from_ae_date IS NULL;

-- 1d. Under Review / file / returned from A/E (with or without a recorded
--     sent date) → Approved  (expected 13)
-- Principled rule from the cross-tab review: where the current attachment
-- says Approved with a non-null approval_date, trust the attachment. These
-- are the 13 rows whose disposition a later write stomped back to
-- 'Under Review' (the stomp bug itself is fixed separately, NOT here).
UPDATE submittals
SET review_status = 'Approved'
WHERE status <> 'deleted' AND deleted_at IS NULL
  AND review_status = 'Under Review'
  AND storage_path IS NOT NULL
  AND returned_from_ae_date IS NOT NULL;

-- 1e. Pending (drift, via the unvalidated PATCH route) → Received  (expected 3)
-- All three carry received_date and no file — received, nothing further.
UPDATE submittals
SET review_status = 'Received'
WHERE status <> 'deleted' AND deleted_at IS NULL
  AND review_status = 'Pending';

-- 1f. Review (drift, same route) → Received  (expected 2)
UPDATE submittals
SET review_status = 'Received'
WHERE status <> 'deleted' AND deleted_at IS NULL
  AND review_status = 'Review';

-- ── 2. New column default: fresh rows start life 'Not Started' ───────────
-- (Old default was 'Received'; every insert path now sets the value
-- explicitly, so the default is a backstop, not a code path.)
ALTER TABLE submittals
  ALTER COLUMN review_status SET DEFAULT 'Not Started';

-- ── 2.5 Guard: abort loudly if anything is still out-of-vocab ────────────
-- Covers ALL partitions (the CHECK in step 3 validates soft-deleted rows
-- too). Verified clean 2026-07-17; this protects against rows written with
-- old vocabulary between authoring and run time.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('%L × %s', review_status, n), ', ')
  INTO v_bad
  FROM (
    SELECT review_status, count(*) AS n
    FROM submittals
    WHERE review_status IS NOT NULL
      AND review_status NOT IN (
        'Not Started', 'Received', 'Sent to A/E',
        'Approved', 'Approved as Noted', 'Revise & Resubmit',
        'Rejected', 'Closed')
    GROUP BY review_status
  ) bad;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'review_status values outside the 0046 vocabulary remain (%). '
      'A row was likely written with old vocabulary after this migration '
      'was authored — re-run the 0046 dry-run, resolve, then re-run. '
      'Nothing was committed.', v_bad;
  END IF;
END $$;

-- ── 3. CHECK constraint — the vocabulary becomes a DB invariant ──────────
-- Plain IN list (no NULL escape: 0 NULL rows exist, and SQL CHECK semantics
-- pass NULL regardless). Applies to every row, soft-deleted included.
ALTER TABLE submittals
  ADD CONSTRAINT submittals_review_status_check
  CHECK (review_status IN (
    'Not Started', 'Received', 'Sent to A/E',
    'Approved', 'Approved as Noted', 'Revise & Resubmit',
    'Rejected', 'Closed'));

COMMIT;
