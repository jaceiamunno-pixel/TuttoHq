-- 0037b: transmittal packages have no vendor and no recipient email
--
-- submittal_packages.sent_to_email and .vendor_name_snapshot were NOT NULL
-- with no default — artifacts of the vendor-solicitation model. A transmittal
-- has neither. Without this, the transmittal INSERT wrote sentinel empty
-- strings, indistinguishable from real data to any future IS NOT NULL query.
--
-- Dropping NOT NULL never rewrites the table and never invalidates existing
-- rows. Columns are NOT dropped here — a later cleanup migration removes them
-- once no code reads them.
--
-- Idempotent: DROP NOT NULL is a no-op if already dropped.

ALTER TABLE submittal_packages
  ALTER COLUMN sent_to_email        DROP NOT NULL,
  ALTER COLUMN vendor_name_snapshot DROP NOT NULL;
