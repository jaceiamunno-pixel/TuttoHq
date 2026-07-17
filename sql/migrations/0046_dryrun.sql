-- 0046 DRY-RUN (read-only). Run BEFORE 0046_review_status_vocabulary.sql.
--
-- Returns ONLY the rows the backfill will change — one row per changed
-- submittal with old → new — so the result is reviewable (process lesson
-- from 0039: a dry-run as wide as the table gets run unchecked).
--
-- Expected as of authoring (2026-07-17, read-only verified): 531 rows.
--   421 Received → Not Started        21 Under Review → Sent to A/E
--    71 Needs Review → Not Started    13 Under Review → Approved
--     3 Pending → Received             2 Review → Received
-- The Vault cross-tab snapshot said 534 — prod moved between snapshot and
-- authoring (live partition 626 → 628, 'Needs Review' 74 → 71). Predicates
-- are unchanged from the approved cross-tab; only counts drift with use.
-- If counts differ from the above when YOU run it, eyeball the delta rows
-- here before running 0046 (the migration's step-2.5 guard aborts the whole
-- transaction if anything out-of-vocab would survive, so a stale dry-run
-- cannot cause a half-applied or wrong write — only an aborted run).
--
-- The CASE mirrors the migration's six UPDATEs bucket-for-bucket; the WHERE
-- keeps only rows whose value actually changes.

SELECT
  id,
  csi_section,
  file_name,
  source,
  storage_path IS NOT NULL AS has_file,
  received_date,
  sent_to_ae_date,
  returned_from_ae_date,
  review_status AS old_status,
  CASE
    WHEN review_status = 'Received'     AND storage_path IS NULL
         AND received_date IS NULL AND sent_to_ae_date IS NULL
         AND returned_from_ae_date IS NULL              THEN 'Not Started'   -- 1a
    WHEN review_status = 'Needs Review' AND storage_path IS NULL
         AND received_date IS NULL AND sent_to_ae_date IS NULL
         AND returned_from_ae_date IS NULL              THEN 'Not Started'   -- 1b
    WHEN review_status = 'Under Review' AND storage_path IS NOT NULL
         AND sent_to_ae_date IS NOT NULL
         AND returned_from_ae_date IS NULL              THEN 'Sent to A/E'   -- 1c
    WHEN review_status = 'Under Review' AND storage_path IS NOT NULL
         AND returned_from_ae_date IS NOT NULL          THEN 'Approved'      -- 1d
    WHEN review_status = 'Pending'                      THEN 'Received'      -- 1e
    WHEN review_status = 'Review'                       THEN 'Received'      -- 1f
  END AS new_status
FROM submittals
WHERE status <> 'deleted' AND deleted_at IS NULL        -- live partition only
  AND (
        (review_status = 'Received'     AND storage_path IS NULL
         AND received_date IS NULL AND sent_to_ae_date IS NULL
         AND returned_from_ae_date IS NULL)
     OR (review_status = 'Needs Review' AND storage_path IS NULL
         AND received_date IS NULL AND sent_to_ae_date IS NULL
         AND returned_from_ae_date IS NULL)
     OR (review_status = 'Under Review' AND storage_path IS NOT NULL
         AND sent_to_ae_date IS NOT NULL
         AND returned_from_ae_date IS NULL)
     OR (review_status = 'Under Review' AND storage_path IS NOT NULL
         AND returned_from_ae_date IS NOT NULL)
     OR  review_status IN ('Pending', 'Review')
      )
ORDER BY old_status, new_status, csi_section, file_name;
