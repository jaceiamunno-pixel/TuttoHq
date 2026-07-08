-- Migration 0033: takeoff scale keys by SHEET, not viewer page.
-- ⚠️  ALREADY APPLIED TO PROD — DO NOT RUN. File-parity only.
-- takeoff_marks are addressed by (source_ref, page); (takeoff_id, page) alone
-- collided across multiple sheets that each open at page 0. 0 rows — no backfill.

BEGIN;

ALTER TABLE public.takeoff_page_scales
  ADD COLUMN IF NOT EXISTS source_ref text;

ALTER TABLE public.takeoff_page_scales
  DROP CONSTRAINT IF EXISTS takeoff_page_scales_takeoff_page_uq;

ALTER TABLE public.takeoff_page_scales
  ADD CONSTRAINT takeoff_page_scales_sheet_page_uq
  UNIQUE NULLS NOT DISTINCT (takeoff_id, source_ref, page);

DROP INDEX IF EXISTS takeoff_page_scales_takeoff_page_idx;
CREATE INDEX IF NOT EXISTS takeoff_page_scales_sheet_page_idx
  ON public.takeoff_page_scales (takeoff_id, source_ref, page);

COMMIT;
