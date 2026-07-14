-- ============================================================================
-- Change order freeze trigger — allow deleted_at. Additive (CREATE OR REPLACE of
-- an existing function). Apply AFTER 0045a (needs change_orders.deleted_at).
-- Apply once in the Supabase SQL editor.
--
-- Identical to the live change_orders_freeze_imported() (migration 0005) with a
-- SINGLE added mask line — `v_masked.deleted_at := NEW.deleted_at;` — so that
-- soft-deleting (and restoring) an imported PCO is permitted while every other
-- document-content column stays frozen. Everything else (search_path, the
-- existing masked columns, the restrict_violation raise) is preserved verbatim.
-- The existing trigger binding (trg_change_orders_freeze_imported, 0005) is
-- unchanged and picks up the new function body automatically.
-- ============================================================================

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
    -- soft-delete (0045b): allow deleted_at so imported PCOs stay soft-deletable
    v_masked.deleted_at          := NEW.deleted_at;
    IF NEW IS DISTINCT FROM v_masked THEN
      RAISE EXCEPTION 'Imported PCOs are frozen; only log-workflow fields are editable (change_order %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
