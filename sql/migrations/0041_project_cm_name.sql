-- 0041_project_cm_name.sql
-- Saved default recipient ("Sent To") for outbound transmittal packages: the
-- actual Construction Manager name/company. The transmittal cover used to print
-- a generic recipient-type label ("Construction Manager") that the sender had to
-- manually black out; this stores the real name so it auto-fills instead.
--
-- Nullable, no default. When cm_name IS NULL the cover falls back to the
-- recipient-type label (RECIPIENT_LABEL). The package-create flow pre-fills this
-- value and lets the sender OVERRIDE it per-package at send time — that override
-- affects only that one generated PDF; this column is the saved project default,
-- set in Settings → Projects.
--
-- No RLS change: projects' existing company-scoped SELECT/INSERT/UPDATE/DELETE
-- policies already cover every column on the row.
alter table public.projects
  add column if not exists cm_name text;
