-- ============================================================================
-- COMPANY DISPLAY NAME — optional serif text wordmark for the app chrome.
-- Additive. Apply once in the Supabase SQL editor. DO NOT auto-apply.
--
-- company_settings stores company identity as discrete COLUMNS (logo_path,
-- cover_page_path, address_line1/2, phone, default_oh_p_percent) — not a jsonb
-- blob — so a new field requires a column.
--
-- display_name backs the nav wordmark only (Settings → Company). The chrome
-- fallback chain is: display_name → logo image → app default. Generated PDFs
-- continue to use the logo image + companies.name, NOT this field.
--
-- Until this migration is applied the feature degrades cleanly: GET /api/settings
-- reads the row with select('*'), so a missing column simply yields null and the
-- chrome falls back to the logo image.
-- ============================================================================

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS display_name TEXT;
