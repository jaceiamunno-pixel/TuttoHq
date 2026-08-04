-- ============================================================================
-- 0051 — Daily report auto-context (weather capture + labor snapshot)
--
-- Two nullable columns on daily_reports:
--
--   weather      jsonb — server-captured Open-Meteo snapshot written once at
--                 report creation: {temp_high_f, temp_low_f, conditions,
--                 precipitation_in, wind_max_mph, location, fetched_at,
--                 source}. Best-effort: stays NULL whenever the geocode/fetch
--                 fails, the project (and company_settings) has no address,
--                 or an offline-created report syncs on a later day. Never
--                 user-edited — deliberately NOT in the PATCH allow-list.
--
--   labor_notes  text — the editable "Labor on Site" snapshot. Prefilled
--                 client-side from that date's manpower_assignments
--                 (read-only join — nothing ever writes back to manpower
--                 tables); the super can correct it before save.
--
-- Delays / Deliveries (same feature PR) need NO new columns — they reuse the
-- existing issues_delays / materials_delivered text columns.
--
-- Run manually in the Supabase SQL Editor. Idempotent — safe to re-run.
-- NO RLS/policy changes: both columns ride the existing company-scoped
-- policies on daily_reports. Code is gated by DAILY_0051_LIVE
-- (src/lib/daily-flags.ts) — flip it only after this has run and been
-- verified via introspection.
-- ============================================================================

alter table public.daily_reports add column if not exists weather jsonb;
alter table public.daily_reports add column if not exists labor_notes text;
