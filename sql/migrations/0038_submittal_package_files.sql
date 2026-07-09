-- 0038: append-only package generation history
--
-- submittal_packages.pdf_file_path holds ONE path, overwritten on regeneration.
-- That cannot express:
--   (a) MODE A ("per_item"), which produces N PDFs (one per submittal), and
--   (b) the rule that every generated artifact is retained — re-generating a
--       package APPENDS a new historical entry; it never overwrites.
--
-- Model: each GENERATION writes one row per emitted file.
--   submittal_id NULL  → the whole-package PDF (mode 'package')
--   submittal_id SET   → that item's PDF (mode 'per_item')
-- A 'package' generation writes 1 row. A 'per_item' generation writes N rows
-- sharing one generation_id.
--
-- "Past generations" = select ... order by generated_at desc, grouped by
-- generation_id.
--
-- APPEND-ONLY: no UPDATE policy is granted. Nothing can rewrite history
-- through PostgREST. Enforced by policy absence, not by trigger.
--
-- FK rules are deliberate:
--   package_id   ON DELETE CASCADE  — deleting a package removes its files.
--   submittal_id ON DELETE SET NULL — the Linkage Law: deleting a submittal
--                                     must not destroy the record of what was sent.
--
-- submittal_packages.pdf_file_path is now LEGACY. Left in place, not dropped,
-- not written by the transmittal path.
--
-- Idempotent. Add-only. No existing rows touched.

CREATE TABLE IF NOT EXISTS submittal_package_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT get_my_company_id(),
  package_id      uuid NOT NULL REFERENCES submittal_packages(id) ON DELETE CASCADE,
  submittal_id    uuid          REFERENCES submittals(id) ON DELETE SET NULL,
  generation_id   uuid NOT NULL,
  coversheet_mode text NOT NULL CHECK (coversheet_mode IN ('per_item','package')),
  storage_path    text NOT NULL,
  file_name       text NOT NULL,
  file_size       bigint,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  generated_by    uuid
);

CREATE INDEX IF NOT EXISTS idx_spf_package_generated
  ON submittal_package_files(package_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_spf_generation
  ON submittal_package_files(generation_id);

ALTER TABLE submittal_package_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY spf_select ON submittal_package_files
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY spf_insert ON submittal_package_files
  FOR INSERT WITH CHECK (company_id = get_my_company_id());

CREATE POLICY spf_delete ON submittal_package_files
  FOR DELETE USING (company_id = get_my_company_id());

CREATE POLICY spf_no_demo_insert ON submittal_package_files
  AS RESTRICTIVE FOR INSERT WITH CHECK (NOT is_demo_user());

CREATE POLICY spf_no_demo_delete ON submittal_package_files
  AS RESTRICTIVE FOR DELETE USING (NOT is_demo_user());
