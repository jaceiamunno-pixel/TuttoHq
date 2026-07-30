-- ============================================================================
-- 0050 — Daily Reports flagship rebuild (ADR: daily-reports-flagship)
--
-- Adds the schema for: crew breakdown (jsonb), draft → submitted lifecycle,
-- soft delete, and photo captions. UI + routes land in PR feat/daily-reports-flagship.
--
-- Run manually in the Supabase SQL Editor. Idempotent — safe to re-run.
-- NO RLS/policy changes: every column below rides the existing
-- company-scoped policies on daily_reports / item_photos.
--
-- LEGACY-STATUS HANDLING (the NOT NULL DEFAULT 'draft' backfill):
--   Every pre-existing report (all THP reports) is backfilled status='draft',
--   submitted_at NULL. The UI treats status as a POSITIVE-SIGNAL-ONLY field:
--   'submitted' adds a badge / lock banner / PDF stamp; 'draft' adds NOTHING —
--   draft rows render exactly as reports render today (no "unsubmitted"
--   warning, no visual demotion, no created_at cutoff heuristics). Legacy
--   reports therefore look identical before and after this migration; the
--   Submit action is simply available on them (harmless, optionally useful).
--   No data is fabricated (we deliberately do NOT backfill submitted_at).
-- ============================================================================

-- Crew breakdown: [{"trade": text, "count": int, "hours": numeric}, ...]
-- Derived headcount total is still written to manpower_count on every save
-- for back-compat with existing list / PDF / export readers.
alter table public.daily_reports add column if not exists crew jsonb;

-- Draft → submitted lifecycle (v1: no approval chain, no hard lock).
alter table public.daily_reports add column if not exists status text not null default 'draft' check (status in ('draft','submitted'));
alter table public.daily_reports add column if not exists submitted_at timestamptz;
alter table public.daily_reports add column if not exists submitted_by uuid references auth.users(id) on delete set null;

-- Soft delete (two-verb discipline: DELETE route stamps this; all list
-- queries filter `deleted_at is null`; 10 s undo clears it).
alter table public.daily_reports add column if not exists deleted_at timestamptz;

-- ── ADDITION beyond the specced column list — strike if unwanted ──────────
-- Feature (g) requires "edited after submission" WITH last-edit attribution.
-- daily_reports predates migrations.sql and has no updated_at/updated_by, so
-- there is nothing to attribute an edit to. These two columns are written by
-- the PATCH route on every successful edit (no trigger). If struck, the UI
-- degrades gracefully: the banner shows only when these fields are present
-- and newer than submitted_at, otherwise nothing renders.
alter table public.daily_reports add column if not exists updated_at timestamptz;
alter table public.daily_reports add column if not exists updated_by uuid references auth.users(id) on delete set null;
-- ──────────────────────────────────────────────────────────────────────────

-- Photo captions (inline edit in gallery + lightbox; rendered under photos
-- in the PDF). Only column change to item_photos — the /api/photos
-- polymorphic contract is otherwise untouched.
alter table public.item_photos add column if not exists caption text;
