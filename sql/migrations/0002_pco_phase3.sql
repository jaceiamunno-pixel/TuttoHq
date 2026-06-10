-- ============================================================================
-- PCO BUILDER — Phase 3 hardening. Additive. Apply once in the Supabase SQL editor.
-- (1) signer_title column
-- (2) partial unique index on builder co_numbers (scoped to has_pco_detail=true)
-- (3) save_pco() — atomic create/update with self-retrying number derivation
-- ============================================================================

-- (1) Snapshot the signer's title on the row (like submitted_by). Nullable.
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS signer_title TEXT;

-- (2) Uniqueness guarantee for builder PCO numbers, scoped so it CANNOT collide
-- with legacy "CO-00N" rows (has_pco_detail = false/null). A partial unique
-- INDEX is the only way to express partial uniqueness in Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_orders_project_pco_number
  ON change_orders (project_id, co_number)
  WHERE has_pco_detail = true;

-- (3) Atomic save. SECURITY INVOKER (default) so RLS + the company_id DEFAULT
-- apply as the caller. Create path retries the MAX-derivation on a unique
-- collision (the losing concurrent writer re-reads the committed MAX and takes
-- the next number). Parent + line items are one function = one transaction, so
-- any failure rolls back atomically — never an orphan parent or half-saved PCO.
-- co_number is derived only on create; status / realized_amount /
-- assigned_co_number are never written here.
--
-- NOTE: the numeric filter is a CASE inside MAX(), NOT a WHERE clause — Postgres
-- does not guarantee a WHERE prunes before a SELECT-list cast is evaluated, so
-- "CO-001"::INT would crash on legacy rows. CASE makes non-numeric -> NULL,
-- which MAX ignores.
-- NOTE: output columns are pco_id / pco_co_number (NOT id / co_number) to avoid
-- an ambiguous-column error at CREATE against the same-named table columns.
CREATE OR REPLACE FUNCTION save_pco(
  p_id            UUID,         -- NULL = create, else update this row
  p_project_id    UUID,
  p_date          DATE,
  p_title         TEXT,
  p_description   TEXT,
  p_pricing_sum   NUMERIC,      -- computed server-side (TS computePcoTotals)
  p_schedule_days INT,
  p_ohp           NUMERIC,
  p_signer_name   TEXT,
  p_signer_title  TEXT,
  p_line_items    JSONB
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
    -- create: derive max(numeric co_numbers in project)+1, retry on collision
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
          submitted_by, signer_title, uploaded_by)
        VALUES (
          v_co, p_project_id, COALESCE(p_date, CURRENT_DATE), p_title, p_description, p_pricing_sum,
          p_schedule_days, p_ohp, 'Not submitted', true,
          p_signer_name, p_signer_title, auth.uid())
        RETURNING change_orders.id INTO v_id;
        EXIT; -- success
      EXCEPTION WHEN unique_violation THEN
        IF attempt = 5 THEN RAISE; END IF;  -- bounded; effectively unreachable
      END;
    END LOOP;
  ELSE
    -- update: only a builder PCO; co_number + status untouched
    UPDATE change_orders
       SET date = COALESCE(p_date, date), proposal = p_title, description_of_work = p_description,
           pricing_sum = p_pricing_sum, schedule_impact_days = p_schedule_days, oh_p_percent = p_ohp,
           submitted_by = p_signer_name, signer_title = p_signer_title, updated_at = now()
     WHERE change_orders.id = p_id AND has_pco_detail = true
     RETURNING change_orders.id, change_orders.co_number INTO v_id, v_co;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'PCO not found or not a builder PCO' USING ERRCODE = 'no_data_found';
    END IF;
    DELETE FROM change_order_line_items WHERE change_order_id = p_id;
  END IF;

  -- (re)insert line items. company_id filled by its DEFAULT under RLS.
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

REVOKE ALL  ON FUNCTION save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,TEXT,TEXT,JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION save_pco(UUID,UUID,DATE,TEXT,TEXT,NUMERIC,INT,NUMERIC,TEXT,TEXT,JSONB) TO authenticated;
