-- ============================================================================
-- PCO BUILDER — add Fee (a percent of the full pre-fee total). Additive.
-- fee_amount = fee_percent * (labor + materials + OH&P + subcontractor),
-- added on top of that total. Computed in app (computePcoTotals); stored only
-- as the percent, like oh_p_percent.
--
-- save_pco gains p_fee_percent (after p_ohp). Arg-list change => drop + recreate
-- the 12-arg version. Safe: no deployed code calls save_pco yet (PCO branch
-- unmerged), so no live dependency during the swap.
-- ============================================================================

ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(5,4);

DROP FUNCTION IF EXISTS save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,TEXT,TEXT,TEXT,JSONB);

CREATE OR REPLACE FUNCTION save_pco(
  p_id                   UUID,
  p_project_id           UUID,
  p_date                 DATE,
  p_title                TEXT,
  p_description          TEXT,
  p_pricing_sum          NUMERIC,
  p_schedule_days        INT,
  p_ohp                  NUMERIC,
  p_fee_percent          NUMERIC,
  p_signer_name          TEXT,
  p_signer_title         TEXT,
  p_signer_signature_path TEXT,
  p_line_items           JSONB
) RETURNS TABLE (pco_id UUID, pco_co_number TEXT)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id   UUID;
  v_co   TEXT;
  v_next INT;
BEGIN
  IF p_id IS NULL THEN
    FOR attempt IN 1..5 LOOP
      SELECT COALESCE(MAX(CASE WHEN co_number ~ '^[0-9]+$' THEN co_number::INT END), 0) + 1
        INTO v_next FROM change_orders WHERE project_id = p_project_id;
      v_co := LPAD(v_next::TEXT, 3, '0');
      BEGIN
        INSERT INTO change_orders (
          co_number, project_id, date, proposal, description_of_work, pricing_sum,
          schedule_impact_days, oh_p_percent, fee_percent, status, has_pco_detail,
          submitted_by, signer_title, signer_signature_path, uploaded_by)
        VALUES (
          v_co, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
          p_schedule_days, p_ohp, p_fee_percent, 'Not submitted', true,
          p_signer_name, p_signer_title, p_signer_signature_path, auth.uid())
        RETURNING change_orders.id INTO v_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF attempt = 5 THEN RAISE; END IF;
      END;
    END LOOP;
  ELSE
    UPDATE change_orders
       SET date = COALESCE(p_date, date), proposal = p_title, description_of_work = p_description,
           pricing_sum = p_pricing_sum, schedule_impact_days = p_schedule_days,
           oh_p_percent = p_ohp, fee_percent = p_fee_percent,
           submitted_by = p_signer_name, signer_title = p_signer_title,
           signer_signature_path = p_signer_signature_path, updated_at = now()
     WHERE change_orders.id = p_id AND has_pco_detail = true
     RETURNING change_orders.id, change_orders.co_number INTO v_id, v_co;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'PCO not found or not a builder PCO' USING ERRCODE = 'no_data_found';
    END IF;
    DELETE FROM change_order_line_items WHERE change_order_id = p_id;
  END IF;

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

  RETURN QUERY
    SELECT v_id,
           COALESCE(v_co, (SELECT change_orders.co_number FROM change_orders WHERE change_orders.id = v_id));
END;
$$;

REVOKE ALL  ON FUNCTION save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) TO authenticated;
