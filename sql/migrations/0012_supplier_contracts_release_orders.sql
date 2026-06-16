-- Migration 0012: Supplier contracts + PO release-order drawdown.
ALTER TABLE commitments DROP CONSTRAINT commitments_type_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_type_check
  CHECK (type = ANY (ARRAY['subcontract','purchase_order','supplier_contract']));

ALTER TABLE commitments ADD COLUMN parent_commitment_id uuid REFERENCES commitments(id) ON DELETE SET NULL;

ALTER TABLE commitments ADD CONSTRAINT commitments_parent_rules CHECK (
  parent_commitment_id IS NULL
  OR (type = 'purchase_order' AND parent_commitment_id <> id)
) NOT VALID;

CREATE INDEX idx_commitments_parent ON commitments(parent_commitment_id) WHERE parent_commitment_id IS NOT NULL;

CREATE OR REPLACE VIEW commitment_balances
WITH (security_invoker = true) AS
SELECT
  c.id AS commitment_id, c.company_id, c.project_id, c.vendor_id, c.type, c.cost_code, c.contract_value,
  COALESCE((SELECT SUM(cc.amount) FROM commitment_changes cc WHERE cc.commitment_id = c.id AND cc.status='approved'),0) AS approved_changes,
  c.contract_value + COALESCE((SELECT SUM(cc.amount) FROM commitment_changes cc WHERE cc.commitment_id = c.id AND cc.status='approved'),0) AS revised_value,
  COALESCE((SELECT SUM(ci.amount) FROM commitment_invoices ci WHERE ci.commitment_id = c.id),0) AS billed_to_date,
  COALESCE((SELECT SUM(ci.retainage_amount) FROM commitment_invoices ci WHERE ci.commitment_id = c.id),0) AS retainage_held,
  c.contract_value + COALESCE((SELECT SUM(cc.amount) FROM commitment_changes cc WHERE cc.commitment_id = c.id AND cc.status='approved'),0)
    - COALESCE((SELECT SUM(ci.amount) FROM commitment_invoices ci WHERE ci.commitment_id = c.id),0) AS remaining_balance,
  COALESCE((SELECT SUM(ci.amount) FROM commitment_invoices ci WHERE ci.commitment_id = c.id),0)
    - COALESCE((SELECT SUM(ci.retainage_amount) FROM commitment_invoices ci WHERE ci.commitment_id = c.id),0) AS net_paid,
  COALESCE((SELECT SUM(child.contract_value) FROM commitments child WHERE child.parent_commitment_id = c.id),0) AS released_to_children,
  c.contract_value - COALESCE((SELECT SUM(child.contract_value) FROM commitments child WHERE child.parent_commitment_id = c.id),0) AS contract_remaining
FROM commitments c;
