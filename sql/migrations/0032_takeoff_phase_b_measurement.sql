-- Migration 0032: Bid Takeoff — Phase B (Measurement).
-- ADDITIVE ONLY. Extends the count-only Bid Takeoff schema (0025) to carry linear
-- and area measurements alongside count dots:
--   • takeoff_marks gains kind / points / raw_measure (+ CHECKs)
--   • new takeoff_page_scales table holds the per-sheet-page scale calibration
-- Mirrors the takeoff tenant pattern (0025) and the 0022 house style:
-- get_my_company_id()-scoped RLS, authenticated-only policies, explicit DELETE
-- policy (a missing DELETE policy = silent no-op; see CLAUDE.md RLS note).
--
-- ⚠️  ALREADY APPLIED TO PROD — DO NOT RUN THIS FILE.
-- Phase B was applied manually in the Supabase SQL Editor; prod is the source of
-- truth. This file is committed for parity/history ONLY. It was RECONSTRUCTED
-- from the feature (kind/points/raw_measure + takeoff_page_scales) and the 0025
-- takeoff conventions, NOT introspected from prod (the read-only MCP was
-- unauthenticated at authoring time). Column TYPES and the takeoff_page_scales
-- internals below are best-effort — DIFF against the live schema
-- (information_schema.columns / pg_constraint / pg_policies) before treating this
-- as authoritative or replaying it into a fresh environment. Written fully
-- idempotent so a verified replay is safe if it is ever needed.
--
-- NUMBERING: highest committed file was 0022; 0025+ (incl. the 0025 takeoff base)
-- were applied via the write connector and are not committed as files. 0032 is
-- the next free number reserved for this Phase B change.

BEGIN;

-- ============================================================================
-- 1. takeoff_marks — measurement columns.
-- kind:        which geometry this row is. 'count' = the original single-dot
--              behavior (uses x,y); 'linear'/'area' use `points`.
-- points:      ordered normalized [0,1] vertices (jsonb array of {x,y}) for
--              linear (polyline) and area (polygon) marks. NULL for count.
-- raw_measure: the geometric measure in NORMALIZED page units (segment length
--              for linear, polygon area for area), pre-scale. NULL for count.
--              Real-world value = raw_measure × takeoff_page_scales.scale_factor
--              for the matching sheet-page, resolved at read time.
-- ============================================================================
ALTER TABLE public.takeoff_marks
  ADD COLUMN IF NOT EXISTS kind        text             NOT NULL DEFAULT 'count',
  ADD COLUMN IF NOT EXISTS points      jsonb,
  ADD COLUMN IF NOT EXISTS raw_measure double precision;

-- CHECKs (ADD CONSTRAINT has no IF NOT EXISTS — guard on pg_constraint).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'takeoff_marks_kind' AND conrelid = 'public.takeoff_marks'::regclass
  ) THEN
    ALTER TABLE public.takeoff_marks
      ADD CONSTRAINT takeoff_marks_kind CHECK (kind IN ('count','linear','area'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'takeoff_marks_measure_nonneg' AND conrelid = 'public.takeoff_marks'::regclass
  ) THEN
    ALTER TABLE public.takeoff_marks
      ADD CONSTRAINT takeoff_marks_measure_nonneg
      CHECK (raw_measure IS NULL OR raw_measure >= 0);
  END IF;
END $$;

-- ============================================================================
-- 2. takeoff_page_scales — one scale calibration per (takeoff, sheet, page).
-- The user calibrates a known real-world distance against a drawn segment; the
-- resulting scale_factor (real units per 1.0 of normalized page distance) turns
-- each linear/area mark's raw_measure into a real-world quantity. source_ref +
-- page match takeoff_marks (source_ref = drawing_sheets id, page-0 viewer).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.takeoff_page_scales (
  id           uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  takeoff_id   uuid             NOT NULL REFERENCES public.takeoffs(id) ON DELETE CASCADE,
  company_id   uuid             NOT NULL DEFAULT get_my_company_id(),
  source_ref   text,                                        -- drawing_sheets id of the calibrated sheet
  page         integer          NOT NULL DEFAULT 0,
  scale_factor double precision NOT NULL,                   -- real-world units per normalized page unit
  unit         text             NOT NULL DEFAULT 'ft',
  created_at   timestamptz      NOT NULL DEFAULT now(),
  created_by   uuid             DEFAULT auth.uid(),
  CONSTRAINT takeoff_page_scales_factor_pos CHECK (scale_factor > 0),
  CONSTRAINT takeoff_page_scales_unique     UNIQUE (takeoff_id, source_ref, page)
);

CREATE INDEX IF NOT EXISTS idx_takeoff_page_scales_company ON public.takeoff_page_scales (company_id);
CREATE INDEX IF NOT EXISTS idx_takeoff_page_scales_takeoff ON public.takeoff_page_scales (takeoff_id);

-- ============================================================================
-- RLS — company-scoped, authenticated only (mirrors 0025 takeoff tables). All
-- four ops are given explicit policies; scales are hard-deleted (no soft-delete),
-- so the DELETE policy is required to avoid a silent no-op.
-- ============================================================================
ALTER TABLE public.takeoff_page_scales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS takeoff_page_scales_select ON public.takeoff_page_scales;
DROP POLICY IF EXISTS takeoff_page_scales_insert ON public.takeoff_page_scales;
DROP POLICY IF EXISTS takeoff_page_scales_update ON public.takeoff_page_scales;
DROP POLICY IF EXISTS takeoff_page_scales_delete ON public.takeoff_page_scales;

CREATE POLICY takeoff_page_scales_select ON public.takeoff_page_scales
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

CREATE POLICY takeoff_page_scales_insert ON public.takeoff_page_scales
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY takeoff_page_scales_update ON public.takeoff_page_scales
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY takeoff_page_scales_delete ON public.takeoff_page_scales
  FOR DELETE TO authenticated
  USING (company_id = get_my_company_id());

COMMIT;
