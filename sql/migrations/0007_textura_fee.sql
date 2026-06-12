-- ============================================================================
-- TEXTURA FEE — first-class flat cover fee on change_orders / imported PCOs.
-- Additive. Apply once in the Supabase SQL editor. DO NOT auto-apply.
--
-- THP cover sheets carry a flat "Textura" processing fee in the pricing summary.
-- Modeling it explicitly (a) lets the cover total reconcile against the line
-- detail and (b) lets the regenerated cover PDF render a Textura Fee line and a
-- correct grand total. It is a COVER total component only (like Fee) — it is NOT
-- part of the backup pre-fee grand total.
--
--   (1) change_orders.textura_fee  : NUMERIC NOT NULL DEFAULT 0
--   (2) import_pco(): gains p_textura_fee (DEFAULT 0) and stores it on insert.
--
-- FREEZE: textura_fee is intentionally NOT added to the imported-PCO freeze
-- allow-list (migration 0005, change_orders_freeze_imported). The trigger masks
-- only the allow-listed columns, so any column it does NOT mask — including
-- textura_fee — is frozen automatically once origin='imported'. import_pco sets
-- it BEFORE the manual→imported flip, so the value lands and then freezes.
--
-- ORDERING: the import route passes p_textura_fee to import_pco ONLY when the
-- value is non-zero, and falls back to the no-textura call on PGRST202, so the
-- import keeps working before this migration is applied (textura just isn't
-- persisted, and pricing_sum already includes it). Apply this before relying on
-- the persisted column / regenerated-PDF Textura line.
-- ============================================================================

-- (1) column ------------------------------------------------------------------
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS textura_fee NUMERIC NOT NULL DEFAULT 0;

-- (2) import_pco() — add p_textura_fee (DEFAULT 0), stored on the parent insert -
-- Drop the prior 13-arg signature first so there's exactly one import_pco (no
-- overload ambiguity for PostgREST). Body is otherwise identical to 0005.
DROP FUNCTION IF EXISTS import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB);

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
  p_textura_fee           NUMERIC DEFAULT 0
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
    schedule_impact_days, oh_p_percent, fee_percent, textura_fee, status, has_pco_detail,
    submitted_by, signer_title, signer_signature_path, origin, uploaded_by)
  VALUES (
    p_co_number, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
    p_schedule_days, p_ohp, p_fee_percent, COALESCE(p_textura_fee, 0), 'Not submitted', true,
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

  -- Final statement: freeze the now-complete record (trigger allows manual→imported).
  UPDATE change_orders SET origin = 'imported' WHERE id = v_id;

  RETURN QUERY SELECT v_id, p_co_number;
END;
$$;

REVOKE ALL  ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB,NUMERIC) FROM public, anon;
GRANT EXECUTE ON FUNCTION import_pco(UUID,TEXT,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB,NUMERIC) TO authenticated;
