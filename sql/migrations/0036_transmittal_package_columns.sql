-- ─────────────────────────────────────────────────────────────────────────
-- 0036: transmittal-package columns (add-only, nullable)
-- ─────────────────────────────────────────────────────────────────────────
--
-- A submittal package is now a TRANSMITTAL package (PR #98): the PM assembles
-- approved documents and sends them upstream (CM / A/E) or to a subcontractor
-- from their own email client. It records three facts in DEDICATED columns
-- instead of overloading the legacy vendor-solicitation columns:
--
--   recipient_type   who it went to → decides which submittals date column the
--                    route stamps: 'cm'/'ae' → sent_to_ae_date,
--                    'subcontractor' → sent_to_sub_date.
--   send_date        the date it was sent (also the value stamped). NULL on a
--                    saved-but-unsent draft.
--   coversheet_mode  how the PDF was assembled: 'per_item' (a coversheet per
--                    item) or 'package' (one cover, all docs appended).
--
-- ADD-ONLY + NULLABLE so existing solicitation rows stay valid (their new
-- columns are NULL, which the app reads as "legacy package"). The legacy
-- columns (vendor_id, vendor_type, vendor_name_snapshot, sent_to_email,
-- dispatched_at, dispatched_by, gmail_thread_id, status, reminder_*) are
-- INTENTIONALLY LEFT IN PLACE for a later cleanup migration once no code reads
-- them. Nothing is dropped here.
--
-- No new RLS policies needed — the columns inherit the table's existing
-- company-scoped policies. Idempotent (re-running is a no-op).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE submittal_packages
  ADD COLUMN IF NOT EXISTS recipient_type  text CHECK (recipient_type IN ('cm','ae','subcontractor')),
  ADD COLUMN IF NOT EXISTS send_date       date,
  ADD COLUMN IF NOT EXISTS coversheet_mode text CHECK (coversheet_mode IN ('per_item','package'));

-- A transmittal package is one that carries a recipient_type; a NULL means a
-- legacy solicitation package. Index it so the (future) reminder-cron guard and
-- any transmittal-vs-legacy filters stay cheap.
CREATE INDEX IF NOT EXISTS idx_submittal_packages_recipient_type
  ON submittal_packages(recipient_type)
  WHERE recipient_type IS NOT NULL;
