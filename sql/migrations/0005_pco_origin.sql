-- ============================================================================
-- PCO IMPORT — origin tagging + hard freeze for imported historical PCOs.
-- Additive. Apply once in the Supabase SQL editor. DO NOT auto-apply.
--
-- Feature: bulk import of legacy THP-format PCO workbooks into the CO/PCO log.
-- Imported PCOs are FROZEN: every value (esp. historical labor rates) is
-- preserved exactly as imported and can never be edited or reconciled against
-- Settings rates. Enforcement is RLS-adjacent (a BEFORE UPDATE trigger), not
-- just UI, so a direct PATCH/UPDATE on an imported row is rejected too.
--
--   (1) change_orders.origin  : 'manual' (default) | 'imported'
--   (2) trigger: freeze UPDATEs to imported change_orders (allow only the
--       derived PDF-path columns + updated_at, so PDF regeneration still works)
--   (3) trigger: freeze UPDATEs to line items of an imported PCO
--   (4) import_pco(): atomic insert of an imported PCO + its line items, keeping
--       the file's PCO # (no auto-derivation). Collisions surface via the
--       existing partial-unique index uq_change_orders_project_pco_number.
--
-- Soft/hard-delete is unchanged: imported PCOs delete exactly like manual ones
-- (the API hard-deletes change_orders; line items cascade). Only UPDATE is
-- frozen — DELETE is intentionally NOT blocked.
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

-- (2) Freeze imported change_orders against any content UPDATE ----------------
-- The allow-list is the two derived PDF-path columns plus updated_at: those may
-- change (PDF regeneration is idempotent and recomputes from the frozen line
-- items). ANY other column differing between OLD and NEW raises. The comparison
-- masks the allowed columns onto a copy of OLD and tests the whole row with
-- IS DISTINCT FROM, so it stays correct even if columns are added later
-- (a newly added column changing would also be frozen — the safe default).
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
    v_masked.pco_backup_pdf_path := NEW.pco_backup_pdf_path;
    v_masked.pco_cover_pdf_path  := NEW.pco_cover_pdf_path;
    v_masked.updated_at          := NEW.updated_at;
    IF NEW IS DISTINCT FROM v_masked THEN
      RAISE EXCEPTION 'Imported PCOs are frozen and cannot be edited (change_order %).', OLD.id
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

-- (3) Freeze line items whose parent PCO is imported -------------------------
-- BEFORE UPDATE only: INSERT must be allowed (import_pco writes the lines) and
-- DELETE must be allowed (parent ON DELETE CASCADE removes them on a normal
-- delete). This blocks the direct rate-edit vector on a frozen PCO.
CREATE OR REPLACE FUNCTION coli_freeze_imported()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_origin TEXT;
BEGIN
  SELECT origin INTO v_origin FROM change_orders WHERE id = NEW.change_order_id;
  IF v_origin = 'imported' THEN
    RAISE EXCEPTION 'Line items of an imported PCO are frozen (change_order %).', NEW.change_order_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_coli_freeze_imported ON change_order_line_items;
CREATE TRIGGER trg_coli_freeze_imported
  BEFORE UPDATE ON change_order_line_items
  FOR EACH ROW EXECUTE FUNCTION coli_freeze_imported();

-- (4) import_pco() — atomic insert of an imported PCO + its line items --------
-- SECURITY INVOKER (default) so RLS + the company_id DEFAULT apply as the
-- caller. Unlike save_pco, the PCO # is NOT derived: the file's number is kept
-- verbatim (p_co_number, normalized by the route). A collision with an existing
-- builder PCO of the same number raises unique_violation via the partial-unique
-- index uq_change_orders_project_pco_number — the route maps that to a per-row
-- "duplicate" failure (the batch keeps going; the row is named in the result).
-- pricing_sum is computed + verified server-side by the route before this call
-- (same pricing_sum discipline as save_pco). status / realized_amount /
-- assigned_co_number are never written (default 'Not submitted' / NULL).
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
  INSERT INTO change_orders (
    co_number, project_id, date, proposal, description_of_work, pricing_sum,
    schedule_impact_days, oh_p_percent, fee_percent, status, has_pco_detail,
    submitted_by, signer_title, signer_signature_path, origin, uploaded_by)
  VALUES (
    p_co_number, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
    p_schedule_days, p_ohp, p_fee_percent, 'Not submitted', true,
    p_signer_name, p_signer_title, p_signer_signature_path, 'imported', auth.uid())
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

  RETURN QUERY SELECT v_id, p_co_number;
END;
$$;

REVOKE ALL  ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) TO authenticated;
