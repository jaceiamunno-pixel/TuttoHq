-- Migration 0014: enforce company-wide PO-number uniqueness (the real backstop).
--
-- Until now nothing at the DB level prevented a duplicate po_number. The edit
-- route (PR #14) does an app-level company-scoped check, but it is TOCTOU-racy
-- and the create/issue route had no guard at all — so a user who lowered
-- po_next_seq below an already-issued number, or two teammates with overlapping
-- prefix+seq, would silently mint a duplicate. This partial unique index makes
-- issuance fail (Postgres 23505) at creation, which both API paths map to a
-- friendly 409 "PO number already in use". It is also what makes
-- release_po_number()'s recycle-on-insert-failure path actually fire.
--
-- Predicate matches the app guard's namespace EXACTLY:
--   * po_number IS NOT NULL — draft POs (no number yet) never collide.
--   * type = 'purchase_order' — only POs carry a po_number; mirrors the edit
--     route's .eq("type","purchase_order") scoping.
--   * keyed on (company_id, po_number) — numbers are sequenced per-user but POs
--     are company-wide and RLS scopes commitments to the tenant, so the company
--     is the real namespace.
--
-- CAREFUL LANE: review-only first. Run in the Supabase SQL Editor. Prod verified
-- (twice) to have ZERO duplicate (company_id, po_number) pairs under this exact
-- predicate before creation, so the index builds cleanly with no data cleanup.

CREATE UNIQUE INDEX IF NOT EXISTS commitments_company_po_number_uniq
  ON commitments (company_id, po_number)
  WHERE po_number IS NOT NULL AND type = 'purchase_order';
