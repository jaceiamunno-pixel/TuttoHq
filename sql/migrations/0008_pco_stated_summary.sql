-- ============================================================================
-- PCO STATED COVER SUMMARY — persist the cover sheet's pricing summary verbatim.
-- Additive. Apply once in the Supabase SQL editor. DO NOT auto-apply.
--
-- The historical-PCO import is now a DIRECT COPY of the uploaded document: the
-- cover sheet's pricing summary is authoritative and pricing_sum = cover TOTAL.
-- When the backup line detail is absent or omitted (foreign backup), the cover
-- subtotals can't be reconstructed from line items — so they're stored here and
-- the cover PDF renders them verbatim.
--
--   stated_labor_subtotal, stated_materials_subtotal, stated_subcontractor,
--   stated_ohp_amount, stated_fee_amount  (NULL for builder PCOs, which compute
--   from their own line items).
--
-- FREEZE: none of these are in the imported-PCO freeze allow-list (migration
-- 0005), so they freeze automatically once origin='imported'. import_pco sets
-- them BEFORE the manual→imported flip.
--
-- import_pco() gains p_stated_* params (DEFAULT NULL), added after the 0007
-- p_textura_fee param. ORDERING: the import route passes them and falls back to
-- the 0007-era call on PGRST202, so imports keep working before this migration is
-- applied (the stated summary just isn't persisted; pricing_sum already = TOTAL).
-- ============================================================================

-- (1) columns -----------------------------------------------------------------
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS stated_labor_subtotal     NUMERIC;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS stated_materials_subtotal NUMERIC;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS stated_subcontractor      NUMERIC;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS stated_ohp_amount         NUMERIC;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS stated_fee_amount         NUMERIC;

-- (2) import_pco() — add p_stated_* (DEFAULT NULL) after p_textura_fee ---------
-- Drop the prior 14-arg (0007) signature so there's exactly one import_pco.
DROP FUNCTION IF EXISTS import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB,NUMERIC);

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
  p_line_items            JSONB,
  p_textura_fee           NUMERIC DEFAULT 0,
  p_stated_labor          NUMERIC DEFAULT NULL,
  p_stated_materials      NUMERIC DEFAULT NULL,
  p_stated_sub            NUMERIC DEFAULT NULL,
  p_stated_ohp            NUMERIC DEFAULT NULL,
  p_stated_fee            NUMERIC DEFAULT NULL
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
    schedule_impact_days, oh_p_percent, fee_percent, textura_fee,
    stated_labor_subtotal, stated_materials_subtotal, stated_subcontractor,
    stated_ohp_amount, stated_fee_amount, status, has_pco_detail,
    submitted_by, signer_title, signer_signature_path, origin, uploaded_by)
  VALUES (
    p_co_number, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
    p_schedule_days, p_ohp, p_fee_percent, COALESCE(p_textura_fee, 0),
    p_stated_labor, p_stated_materials, p_stated_sub, p_stated_ohp, p_stated_fee,
    'Not submitted', true,
    p_signer_name, p_signer_title, p_signer_signature_path, 'manual', auth.uid())
  RETURNING change_orders.id INTO v_id;

  -- company_id filled by its DEFAULT under RLS (same as save_pco). When there is
  -- no importable line detail, p_line_items is '[]' and no lines are written.
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

  -- Final statement: freeze the now-complete record (trigger allows manual→imported).
  UPDATE change_orders SET origin = 'imported' WHERE id = v_id;

  RETURN QUERY SELECT v_id, p_co_number;
END;
$$;

REVOKE ALL  ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC) FROM public, anon;
GRANT EXECUTE ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC) TO authenticated;
