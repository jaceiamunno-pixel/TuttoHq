-- ============================================================================
-- PCO IMPORT — origin tagging + hard freeze for imported historical PCOs. (v2)
-- Additive. Apply once in the Supabase SQL editor. DO NOT auto-apply.
--
-- Feature: bulk import of legacy THP-format PCO workbooks into the CO/PCO log.
-- Imported PCOs freeze the DOCUMENT CONTENT exactly as imported (rates,
-- quantities, amounts, title, description, dates, fee/OH&P, pricing_sum, signer
-- fields, the PCO number, origin). LOG-WORKFLOW state that does NOT exist in the
-- source document stays editable so the imported log is still manageable:
-- status, assigned_co_number, realized_amount, assigned_to, approved_at.
-- Enforcement is RLS-adjacent (BEFORE-trigger), not just UI, so a direct
-- PATCH/UPDATE on an imported row is rejected too.
--
--   (1) change_orders.origin  : 'manual' (default) | 'imported'
--   (2) trigger: freeze UPDATEs to imported change_orders EXCEPT the log-workflow
--       + derived-PDF + updated_at allow-list
--   (3) trigger: freeze INSERT / UPDATE / single-row DELETE of line items under
--       an imported PCO (cascade delete from the parent still allowed)
--   (4) import_pco(): atomic insert of an imported PCO + its line items, keeping
--       the file's PCO #. Inserts the parent as 'manual', writes the lines, then
--       flips origin to 'imported' as the final statement (so trigger 3 lets the
--       lines in). Collisions surface via the existing partial-unique index.
--
-- Soft/hard-delete is unchanged: imported PCOs delete exactly like manual ones
-- (the API hard-deletes change_orders; line items cascade). Only content UPDATE
-- is frozen — DELETE is intentionally NOT blocked.
-- ============================================================================

-- (1) origin column ----------------------------------------------------------
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';

-- CHECK added separately (ADD COLUMN IF NOT EXISTS won't attach a CHECK when the
-- column already exists). Guarded so the migration is safely re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_orders_origin_check'
  ) THEN
    ALTER TABLE change_orders
      ADD CONSTRAINT change_orders_origin_check CHECK (origin IN ('manual','imported'));
  END IF;
END $$;

-- (2) Freeze imported change_orders' DOCUMENT content against UPDATE -----------
-- Allow-list (may change on an imported row):
--   • log-workflow state (NOT in the source doc): status, assigned_co_number,
--     realized_amount, assigned_to, approved_at
--   • derived artifacts: pco_backup_pdf_path, pco_cover_pdf_path
--   • bookkeeping: updated_at
-- Everything else is frozen: any other column differing between OLD and NEW
-- raises. The check masks the allowed columns onto a copy of OLD and tests the
-- whole row with IS DISTINCT FROM, so it stays correct if columns are added
-- later (a newly added column changing would be frozen — the safe default), and
-- it blocks un-freezing (imported→manual on origin is rejected: origin is not
-- masked, so it differs).
--
-- NOTE: if a soft-delete column (e.g. deleted_at) is ever added to
-- change_orders, it MUST be added to this allow-list, or imported rows become
-- un-soft-deletable.
CREATE OR REPLACE FUNCTION change_orders_freeze_imported()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_masked change_orders%ROWTYPE;
BEGIN
  IF OLD.origin = 'imported' THEN
    v_masked := OLD;
    -- log-workflow state (does not exist in the imported document)
    v_masked.status             := NEW.status;
    v_masked.assigned_co_number := NEW.assigned_co_number;
    v_masked.realized_amount    := NEW.realized_amount;
    v_masked.assigned_to        := NEW.assigned_to;
    v_masked.approved_at        := NEW.approved_at;
    -- derived artifacts (regeneration recomputes from the frozen line items)
    v_masked.pco_backup_pdf_path := NEW.pco_backup_pdf_path;
    v_masked.pco_cover_pdf_path  := NEW.pco_cover_pdf_path;
    -- bookkeeping
    v_masked.updated_at          := NEW.updated_at;
    IF NEW IS DISTINCT FROM v_masked THEN
      RAISE EXCEPTION 'Imported PCOs are frozen; only log-workflow fields are editable (change_order %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_change_orders_freeze_imported ON change_orders;
CREATE TRIGGER trg_change_orders_freeze_imported
  BEFORE UPDATE ON change_orders
  FOR EACH ROW EXECUTE FUNCTION change_orders_freeze_imported();

-- (3) Freeze line items under an imported PCO --------------------------------
-- Covers all three mutation vectors against a frozen PCO's pricing backup:
--   • INSERT  → block when the parent is imported (during import_pco the parent
--               is still 'manual', so the initial line insert is allowed)
--   • UPDATE  → block when the parent is imported (rate-edit vector)
--   • DELETE  → block a single-row delete when the parent is imported; ALLOW
--               when the parent row is already gone (ON DELETE CASCADE from a
--               normal parent delete is in progress)
CREATE OR REPLACE FUNCTION coli_freeze_imported()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_origin TEXT;
  v_parent UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.change_order_id ELSE NEW.change_order_id END;
  v_found  BOOLEAN;
BEGIN
  SELECT origin INTO v_origin FROM change_orders WHERE id = v_parent;
  v_found := FOUND;

  IF TG_OP = 'DELETE' AND NOT v_found THEN
    RETURN OLD;  -- parent already deleted → cascade in progress, allow
  END IF;

  IF v_origin = 'imported' THEN
    RAISE EXCEPTION 'Line items of an imported PCO are frozen (change_order %).', v_parent
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_coli_freeze_imported ON change_order_line_items;
CREATE TRIGGER trg_coli_freeze_imported
  BEFORE INSERT OR UPDATE OR DELETE ON change_order_line_items
  FOR EACH ROW EXECUTE FUNCTION coli_freeze_imported();

-- (4) import_pco() — atomic insert of an imported PCO + its line items --------
-- SECURITY INVOKER (default) so RLS + the company_id DEFAULT apply as the
-- caller. Unlike save_pco, the PCO # is NOT derived: the file's number is kept
-- verbatim (p_co_number, normalized by the route). A collision with an existing
-- builder/imported PCO of the same number raises unique_violation via the
-- partial-unique index uq_change_orders_project_pco_number — the route maps that
-- to a per-row "duplicate" failure (the batch keeps going; the row is named).
--
-- ORDER MATTERS (trigger 3): insert the parent as origin='manual', insert the
-- line items (allowed while parent is 'manual'), THEN flip origin to 'imported'
-- as the final statement (trigger 2 permits manual→imported). status stays
-- 'Not submitted' here; the chosen review status is applied by the route AFTER
-- commit via the normal status-update path. pricing_sum is computed + verified
-- server-side by the route before this call (same discipline as save_pco).
CREATE OR REPLACE FUNCTION import_pco(
  p_project_id            UUID,
  p_co_number             TEXT,
  p_date                  DATE,
  p_title                 TEXT,
  p_description           TEXT,
  p_pricing_sum           NUMERIC,
  p_schedule_days         INT,
  p_ohp                   NUMERIC,
  p_fee_percent           NUMERIC,
  p_signer_name           TEXT,
  p_signer_title          TEXT,
  p_signer_signature_path TEXT,
  p_line_items            JSONB
) RETURNS TABLE (pco_id UUID, pco_co_number TEXT)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Parent inserted as 'manual' so the line-item INSERTs below are permitted.
  INSERT INTO change_orders (
    co_number, project_id, date, proposal, description_of_work, pricing_sum,
    schedule_impact_days, oh_p_percent, fee_percent, status, has_pco_detail,
    submitted_by, signer_title, signer_signature_path, origin, uploaded_by)
  VALUES (
    p_co_number, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
    p_schedule_days, p_ohp, p_fee_percent, 'Not submitted', true,
    p_signer_name, p_signer_title, p_signer_signature_path, 'manual', auth.uid())
  RETURNING change_orders.id INTO v_id;

  -- company_id filled by its DEFAULT under RLS (same as save_pco).
  INSERT INTO change_order_line_items (
    change_order_id, category, description,
    qty_reg, rate_reg, qty_ot, rate_ot, qty_dt, rate_dt,
    qty, unit, unit_price, note, amount, sort_order)
  SELECT v_id, li.category, li.description,
         li.qty_reg, li.rate_reg, li.qty_ot, li.rate_ot, li.qty_dt, li.rate_dt,
         li.qty, li.unit, li.unit_price, li.note, li.amount, li.sort_order
  FROM jsonb_to_recordset(COALESCE(p_line_items, '[]'::jsonb)) AS li(
         category TEXT, description TEXT,
         qty_reg NUMERIC, rate_reg NUMERIC, qty_ot NUMERIC, rate_ot NUMERIC, qty_dt NUMERIC, rate_dt NUMERIC,
         qty NUMERIC, unit TEXT, unit_price NUMERIC, note TEXT, amount NUMERIC, sort_order INT);

  -- Final statement: freeze the now-complete record (trigger 2 allows manual→imported).
  UPDATE change_orders SET origin = 'imported' WHERE id = v_id;

  RETURN QUERY SELECT v_id, p_co_number;
END;
$$;

REVOKE ALL  ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) TO authenticated;
