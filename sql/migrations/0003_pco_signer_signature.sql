-- ============================================================================
-- PCO BUILDER — snapshot the signer's signature path on the row, so a PDF
-- regenerated later (possibly by a different user) embeds the ORIGINAL signer's
-- signature, not the live current user's. Same snapshot reasoning as
-- submitted_by / signer_title. Additive.
--
-- save_pco gains a p_signer_signature_path param. Because changing a function's
-- argument list creates an overload rather than replacing, the old function is
-- dropped first. Safe: no deployed code calls save_pco yet (the PCO feature is
-- still on its branch), so there is no live dependency during the swap.
-- ============================================================================

ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS signer_signature_path TEXT;

DROP FUNCTION IF EXISTS save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,TEXT,TEXT,JSONB);

CREATE OR REPLACE FUNCTION save_pco(
  p_id                   UUID,
  p_project_id           UUID,
  p_date                 DATE,
  p_title                TEXT,
  p_description          TEXT,
  p_pricing_sum          NUMERIC,
  p_schedule_days        INT,
  p_ohp                  NUMERIC,
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
        INTO v_next
        FROM change_orders
        WHERE project_id = p_project_id;
      v_co := LPAD(v_next::TEXT, 3, '0');
      BEGIN
        INSERT INTO change_orders (
          co_number, project_id, date, proposal, description_of_work, pricing_sum,
          schedule_impact_days, oh_p_percent, status, has_pco_detail,
          submitted_by, signer_title, signer_signature_path, uploaded_by)
        VALUES (
          v_co, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
          p_schedule_days, p_ohp, 'Not submitted', true,
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
           pricing_sum = p_pricing_sum, schedule_impact_days = p_schedule_days, oh_p_percent = p_ohp,
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

REVOKE ALL  ON FUNCTION save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,TEXT,TEXT,TEXT,JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,TEXT,TEXT,TEXT,JSONB) TO authenticated;
