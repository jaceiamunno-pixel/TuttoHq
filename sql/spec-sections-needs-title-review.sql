-- ─────────────────────────────────────────────────────────────────────────
-- Migration: spec_sections.needs_title_review
-- ─────────────────────────────────────────────────────────────────────────
--
-- When the spec-book parser can extract neither a clean Layer 1 title
-- (section-prefix / bare-same-line / clean lookahead) nor a Layer 2 title
-- (page-footer pattern), it falls back to the MasterFormat division name
-- ("Finishes", "Openings", "Earthwork", …) and sets needs_title_review=true.
-- The Library log surfaces a small "title needs review" badge on rows
-- pointing at those spec_sections so the user knows to set the title
-- manually for the rare cases the parser truly can't help with.
--
-- Idempotent (IF NOT EXISTS). Safe to run multiple times.
-- Default false → existing rows behave as before (no badge).
ALTER TABLE spec_sections
  ADD COLUMN IF NOT EXISTS needs_title_review boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS spec_sections_needs_title_review_idx
  ON spec_sections(needs_title_review) WHERE needs_title_review = true;
