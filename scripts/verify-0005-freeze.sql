-- ============================================================================
-- Verify migration 0005 (PCO import freeze) behaviour. Run in the Supabase SQL
-- editor AFTER applying 0005_pco_origin.sql. Self-contained: seeds via
-- import_pco, asserts the trigger behaviour, and ROLLS BACK — nothing persists.
-- Read the NOTICE output: every line should start with PASS.
-- ============================================================================
BEGIN;
DO $$
DECLARE
  v_id     UUID;
  v_line   UUID;
  v_origin TEXT;
  v_cnt    INT;
BEGIN
  -- import_pco builds a frozen, lined PCO (parent inserted 'manual', lines
  -- written, then flipped to 'imported' — proving trigger 3 lets the lines in).
  SELECT pco_id INTO v_id FROM import_pco(
    NULL, 'TEST-IMP-042', DATE '2025-12-03', 'Verify Import', 'desc',
    3214.95, 0, 0, 0.15, 'Tester', 'PM', NULL,
    '[{"category":"labor","description":"Carpenter","qty_reg":24,"rate_reg":92.59,"sort_order":0}]'::jsonb);
  SELECT origin INTO v_origin FROM change_orders WHERE id = v_id;
  SELECT count(*) INTO v_cnt FROM change_order_line_items WHERE change_order_id = v_id;
  RAISE NOTICE '% import_pco → origin=%, lines=% (expect imported,1)',
    CASE WHEN v_origin = 'imported' AND v_cnt = 1 THEN 'PASS' ELSE 'FAIL' END, v_origin, v_cnt;

  -- (a) log-workflow update SUCCEEDS
  BEGIN
    UPDATE change_orders SET status='Approved', assigned_co_number='CO-001',
                             realized_amount=3000, assigned_to='Reviewer', approved_at=now()
     WHERE id = v_id;
    RAISE NOTICE 'PASS (a) workflow update allowed (status/CO#/realized/assigned_to)';
  EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL (a) workflow update blocked: %', SQLERRM; END;

  -- (a) document update BLOCKED (pricing_sum stands in for any frozen field)
  BEGIN
    UPDATE change_orders SET pricing_sum = 1.00 WHERE id = v_id;
    RAISE NOTICE 'FAIL (a) document update allowed (pricing_sum)';
  EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS (a) document update blocked (restrict_violation)'; END;

  -- un-freeze BLOCKED (imported→manual)
  BEGIN
    UPDATE change_orders SET origin='manual' WHERE id = v_id;
    RAISE NOTICE 'FAIL un-freeze allowed (imported→manual)';
  EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS un-freeze blocked (imported→manual)'; END;

  SELECT id INTO v_line FROM change_order_line_items WHERE change_order_id = v_id LIMIT 1;

  -- (b) line-item UPDATE BLOCKED
  BEGIN
    UPDATE change_order_line_items SET rate_reg = 1 WHERE id = v_line;
    RAISE NOTICE 'FAIL (b) line UPDATE allowed';
  EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS (b) line UPDATE blocked'; END;

  -- (b) line-item INSERT BLOCKED
  BEGIN
    INSERT INTO change_order_line_items (change_order_id, category, description, amount, sort_order)
      VALUES (v_id, 'subcontractor', 'sneaky', 999, 9);
    RAISE NOTICE 'FAIL (b) line INSERT allowed';
  EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS (b) line INSERT blocked'; END;

  -- (b) single-row line DELETE BLOCKED
  BEGIN
    DELETE FROM change_order_line_items WHERE id = v_line;
    RAISE NOTICE 'FAIL (b) single line DELETE allowed';
  EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS (b) single line DELETE blocked'; END;

  -- (c) full parent DELETE cascades clean (no block; lines auto-removed)
  BEGIN
    DELETE FROM change_orders WHERE id = v_id;
    SELECT count(*) INTO v_cnt FROM change_order_line_items WHERE change_order_id = v_id;
    RAISE NOTICE '% (c) parent delete cascaded; remaining lines=% (expect 0)',
      CASE WHEN v_cnt = 0 THEN 'PASS' ELSE 'FAIL' END, v_cnt;
  EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL (c) parent delete errored: %', SQLERRM; END;
END $$;
ROLLBACK;
