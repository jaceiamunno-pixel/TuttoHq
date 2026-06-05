-- ─────────────────────────────────────────────────────────────────────────
-- Migration: submittals.stripped_storage_path (strip-at-upload, stored copy)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Moves coversheet/stamp stripping OUT of the view hot path. Previously the
-- Library "Open" (?stripped=1) ran unpdf/pdf-lib on every request, and a
-- pathological PDF could cause a PROCESS-LEVEL crash (OOM / pdf.js worker
-- death / timeout) that a try/catch cannot trap → HTTP 500 on every open.
--
-- New model: strip ONCE at upload, store the stripped PDF as a second
-- object, and record its path here. The view then serves a plain stored
-- file (no unpdf, no pdf-lib) — it physically cannot crash on a bad PDF.
--
--   stripped_storage_path = NULL  → no stripped copy (no cover/stamp anchor
--                                   found, or strip not yet run) → the view
--                                   serves the ORIGINAL.
--   stripped_storage_path = path  → serve this stored stripped copy.
--
-- The ORIGINAL (storage_path) is never touched — it stays the record-of-
-- truth (legal/approval artifact + the "Original (w/ stamp)" link).
--
-- Additive, nullable, idempotent. Re-running is a no-op.

ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS stripped_storage_path text;
