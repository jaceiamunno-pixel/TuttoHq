-- 0042_transmittal_email_template.sql
-- Per-tenant transmittal "Send via Email" template (subject + body).
--
-- company_settings stores identity/config as discrete COLUMNS (see 0006), not a
-- jsonb blob — so two new nullable TEXT columns. NULL = the tenant hasn't
-- customized; the app falls back to the built-in default template
-- (src/lib/transmittal-email.ts).
--
-- RLS: company_settings already has company-scoped SELECT/INSERT/UPDATE/DELETE
-- policies (row-level, admin-gated UPDATE). New columns are covered automatically
-- — no policy change needed.
--
-- Apply once in the Supabase SQL editor. DO NOT auto-apply.

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS transmittal_email_subject_template TEXT,
  ADD COLUMN IF NOT EXISTS transmittal_email_body_template    TEXT;
