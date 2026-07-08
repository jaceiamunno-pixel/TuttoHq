-- Migration 0032: Bid Takeoff — Phase B (Measurement).
-- ADDITIVE ONLY. takeoff_marks gains kind/points/raw_measure (+CHECKs); new
-- takeoff_page_scales table holds scale calibration.
--
-- ⚠️  ALREADY APPLIED TO PROD — DO NOT RUN. File-parity only. Reconstructed from
-- the VERIFIED live schema (information_schema/pg_constraint/pg_policies,
-- read-only 2026-07-08) so it byte-matches deployed state. Idempotent.
-- NOTE: 0033 later adds source_ref to takeoff_page_scales and re-keys the unique
-- to (takeoff_id, source_ref, page). This file reflects the ORIGINAL 0032 apply.
-- RLS pattern: 4 permissive get_my_company_id() + 3 restrictive NOT is_demo_user().

BEGIN;

ALTER TABLE public.takeoff_marks
  ADD COLUMN IF NOT EXISTS kind        text             NOT NULL DEFAULT 'count',
  ADD COLUMN IF NOT EXISTS points      jsonb,
  ADD COLUMN IF NOT EXISTS raw_measure double precision;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='takeoff_marks_kind_chk' AND conrelid='public.takeoff_marks'::regclass) THEN
    ALTER TABLE public.takeoff_marks
      ADD CONSTRAINT takeoff_marks_kind_chk CHECK (kind IN ('count','linear','area'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='takeoff_marks_geometry_chk' AND conrelid='public.takeoff_marks'::regclass) THEN
    ALTER TABLE public.takeoff_marks
      ADD CONSTRAINT takeoff_marks_geometry_chk CHECK (
        (kind='count' AND points IS NULL)
        OR (kind IN ('linear','area') AND points IS NOT NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.takeoff_page_scales (
  id            uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  takeoff_id    uuid             NOT NULL REFERENCES public.takeoffs(id) ON DELETE CASCADE,
  company_id    uuid             NOT NULL,
  page          integer          NOT NULL,
  units_per_px  numeric          NOT NULL,
  unit          text             NOT NULL DEFAULT 'ft',
  cal_x1        double precision NOT NULL,
  cal_y1        double precision NOT NULL,
  cal_x2        double precision NOT NULL,
  cal_y2        double precision NOT NULL,
  created_at    timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT takeoff_page_scales_unit_chk         CHECK (unit IN ('ft','in','m')),
  CONSTRAINT takeoff_page_scales_units_per_px_chk CHECK (units_per_px > 0),
  CONSTRAINT takeoff_page_scales_takeoff_page_uq  UNIQUE (takeoff_id, page)
);

CREATE INDEX IF NOT EXISTS takeoff_page_scales_takeoff_page_idx
  ON public.takeoff_page_scales (takeoff_id, page);

ALTER TABLE public.takeoff_page_scales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "takeoff_page_scales: company select" ON public.takeoff_page_scales;
DROP POLICY IF EXISTS "takeoff_page_scales: company insert" ON public.takeoff_page_scales;
DROP POLICY IF EXISTS "takeoff_page_scales: company update" ON public.takeoff_page_scales;
DROP POLICY IF EXISTS "takeoff_page_scales: company delete" ON public.takeoff_page_scales;
CREATE POLICY "takeoff_page_scales: company select" ON public.takeoff_page_scales
  FOR SELECT USING (company_id = get_my_company_id());
CREATE POLICY "takeoff_page_scales: company insert" ON public.takeoff_page_scales
  FOR INSERT WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "takeoff_page_scales: company update" ON public.takeoff_page_scales
  FOR UPDATE USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "takeoff_page_scales: company delete" ON public.takeoff_page_scales
  FOR DELETE USING (company_id = get_my_company_id());

DROP POLICY IF EXISTS demo_readonly_no_insert ON public.takeoff_page_scales;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.takeoff_page_scales;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.takeoff_page_scales;
CREATE POLICY demo_readonly_no_insert ON public.takeoff_page_scales
  AS RESTRICTIVE FOR INSERT WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.takeoff_page_scales
  AS RESTRICTIVE FOR UPDATE USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.takeoff_page_scales
  AS RESTRICTIVE FOR DELETE USING (NOT is_demo_user());

COMMIT;
