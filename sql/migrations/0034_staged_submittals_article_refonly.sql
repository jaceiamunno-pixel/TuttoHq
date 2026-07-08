-- Migration 0034: staged_submittals — article + reference_only.
-- ADDITIVE ONLY. Two new columns so the spec-parser's per-lettered-item grain
-- (section + article + letter) and its reference_only flag survive into
-- staged_submittals, where the Pending Review UI can use the article grain and
-- grey out cross-reference rows. No RLS change (both columns inherit
-- staged_submittals' existing company_id policies), no data mutation, no index.
-- Idempotent (IF NOT EXISTS on both columns).
--
-- NOT YET APPLIED — Jace runs this in the Supabase SQL Editor; Claude then
-- verifies via read-only introspection (information_schema.columns). Pairs with
-- the parse-route insert that writes both columns (reference_only defaults false
-- when the classifier did not flag the row) and defaults ref-only rows to
-- is_selected = false so they are shown but not committed as outstanding.

BEGIN;

ALTER TABLE public.staged_submittals
  ADD COLUMN IF NOT EXISTS article        TEXT,
  ADD COLUMN IF NOT EXISTS reference_only BOOLEAN NOT NULL DEFAULT false;

COMMIT;
