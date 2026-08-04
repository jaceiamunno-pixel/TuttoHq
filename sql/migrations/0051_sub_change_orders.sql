-- =============================================================================
-- Migration 0051: Subcontractor Change Orders (downstream — GC issues COs TO subs)
--
-- Mirrors the change_orders architecture but points the other way: the tenant
-- (GC) authorizes changes to a subcontractor's contract. Modeled on THP's paper
-- "CHANGE ORDER" form (GC -> Stonhard).
--
-- Two tables:
--   sub_change_orders       — the CO header (one per issued change order)
--   sub_change_order_lines  — the authorized-changes line grid
--
-- Design decisions (locked):
--   * Soft-delete = status = 'deleted' — NEVER a deleted_at column here. The
--     partial unique index below excludes deleted rows so a retired number
--     leaves a permanent gap (never recycled).
--   * co_number is user-editable TEXT ("1", "2", ...). The server derives the
--     default as MAX(numeric co_number)+1 per (project_id, vendor_id) — NOT
--     the legacy count(*)+1 (count recycles numbers after deletes). On 23505
--     the route retries once with a re-derived number, then surfaces 409.
--   * snap_* columns are the financial recap snapshotted at PDF generation
--     time (immutable printed evidence — the PCO stated_* pattern). They are
--     computed SERVER-SIDE only; no client-computed money is ever stored.
--   * vendor_id ON DELETE RESTRICT (matches rfq_recipients.vendor_id) — a
--     vendor with issued COs cannot be hard-deleted.
--   * commitment_id ON DELETE SET NULL — optional link to the subcontract;
--     used only to prefill original_contract_amount, which stays editable.
--   * cost_code is TEXT (ADR-002), e.g. "09-700-S".
--   * SELECT policies scope to company_id ONLY — never filter status in the
--     SELECT policy (the 42501 PostgREST RETURNING trap). Status filtering
--     happens in queries.
--   * RLS clones the change_orders 8-policy shape on BOTH tables:
--       4 permissive company-scoped (select/insert/update/delete)
--     + 3 restrictive demo_readonly_no_{insert,update,delete}
--     + 1 restrictive field_no_access_<table> FOR ALL (money surface — hard
--       field lockout per ADR-020; deliberately NO has_project_module_access
--       path).
--     is_demo_user(), get_my_role() and the 'field'/'demo' roles exist in
--     production (0047/0049 + the out-of-band demo-tenant migration).
--
-- Also adds company_settings.fax — the CO form header prints phone + fax and
-- company_settings had no fax column (phone/address_line1/2 already exist).
--
-- Run manually in the Supabase SQL Editor. Idempotent — safe to re-run.
-- =============================================================================

BEGIN;

-- --- 1. sub_change_orders ----------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sub_change_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid REFERENCES companies(id) DEFAULT get_my_company_id(),
  project_id               uuid REFERENCES projects(id) ON DELETE CASCADE,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  commitment_id            uuid REFERENCES commitments(id) ON DELETE SET NULL,

  co_number                text NOT NULL,          -- "1"; user-editable
  original_contract_no     text,                   -- form: "Original Contract No."
  co_date                  date DEFAULT CURRENT_DATE,
  cost_code                text,                   -- header cost code, e.g. 09-700-S
  original_contract_amount numeric,                -- manual; prefilled from commitments.contract_value when linked

  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'sent', 'accepted', 'deleted')),
  generated_pdf_path       text,

  signer_name              text,
  signer_title             text,
  signer_signature_path    text,

  -- Snapshot columns written at PDF generation (immutable printed evidence).
  snap_previous_additions       numeric,
  snap_previous_deductions      numeric,
  snap_previous_total           numeric,
  snap_this_order               numeric,
  snap_present_contract_amount  numeric,

  accepted_at              timestamptz,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now(),
  uploaded_by              uuid REFERENCES auth.users(id)
);

-- --- 2. sub_change_order_lines -----------------------------------------------
-- Draft content under a soft-deletable parent: lines are HARD-deleted (the
-- parent row is the evidence trail; the generated PDF snapshots the grid).

CREATE TABLE IF NOT EXISTS public.sub_change_order_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_change_order_id uuid NOT NULL REFERENCES public.sub_change_orders(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES companies(id) DEFAULT get_my_company_id(),
  owner_co_number     text,
  gc_co_number        text,
  description         text NOT NULL,
  cost_code           text,
  price               numeric NOT NULL DEFAULT 0,
  sort_order          int NOT NULL DEFAULT 0,
  created_at          timestamptz DEFAULT now()
);

-- --- 3. Numbering + indexes --------------------------------------------------
-- Numbering is per (project, vendor). Deleted rows keep their number out of
-- the index so gaps are permanent and numbers are never reused.

CREATE UNIQUE INDEX IF NOT EXISTS sub_change_orders_number_uniq
  ON public.sub_change_orders (project_id, vendor_id, co_number)
  WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_sub_change_orders_company     ON public.sub_change_orders (company_id);
CREATE INDEX IF NOT EXISTS idx_sub_change_orders_project     ON public.sub_change_orders (project_id);
CREATE INDEX IF NOT EXISTS idx_sub_change_orders_vendor      ON public.sub_change_orders (vendor_id);
CREATE INDEX IF NOT EXISTS idx_sub_change_order_lines_sco    ON public.sub_change_order_lines (sub_change_order_id);
CREATE INDEX IF NOT EXISTS idx_sub_change_order_lines_company ON public.sub_change_order_lines (company_id);

-- --- 4. RLS ------------------------------------------------------------------

ALTER TABLE public.sub_change_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sub_change_order_lines ENABLE ROW LEVEL SECURITY;

-- 4a. sub_change_orders — 4 permissive company + 3 demo restrictive + field lockout

DROP POLICY IF EXISTS "sub_change_orders: company select" ON public.sub_change_orders;
DROP POLICY IF EXISTS "sub_change_orders: company insert" ON public.sub_change_orders;
DROP POLICY IF EXISTS "sub_change_orders: company update" ON public.sub_change_orders;
DROP POLICY IF EXISTS "sub_change_orders: company delete" ON public.sub_change_orders;
CREATE POLICY "sub_change_orders: company select" ON public.sub_change_orders
  FOR SELECT TO authenticated
  USING     (company_id = get_my_company_id());
CREATE POLICY "sub_change_orders: company insert" ON public.sub_change_orders
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "sub_change_orders: company update" ON public.sub_change_orders
  FOR UPDATE TO authenticated
  USING     (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "sub_change_orders: company delete" ON public.sub_change_orders
  FOR DELETE TO authenticated
  USING     (company_id = get_my_company_id());

DROP POLICY IF EXISTS demo_readonly_no_insert ON public.sub_change_orders;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.sub_change_orders;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.sub_change_orders;
CREATE POLICY demo_readonly_no_insert ON public.sub_change_orders
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.sub_change_orders
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.sub_change_orders
  AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT is_demo_user());

DROP POLICY IF EXISTS field_no_access_sub_change_orders ON public.sub_change_orders;
CREATE POLICY field_no_access_sub_change_orders ON public.sub_change_orders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (get_my_role() <> 'field') WITH CHECK (get_my_role() <> 'field');

-- 4b. sub_change_order_lines — same 8-policy shape

DROP POLICY IF EXISTS "sub_change_order_lines: company select" ON public.sub_change_order_lines;
DROP POLICY IF EXISTS "sub_change_order_lines: company insert" ON public.sub_change_order_lines;
DROP POLICY IF EXISTS "sub_change_order_lines: company update" ON public.sub_change_order_lines;
DROP POLICY IF EXISTS "sub_change_order_lines: company delete" ON public.sub_change_order_lines;
CREATE POLICY "sub_change_order_lines: company select" ON public.sub_change_order_lines
  FOR SELECT TO authenticated
  USING     (company_id = get_my_company_id());
CREATE POLICY "sub_change_order_lines: company insert" ON public.sub_change_order_lines
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "sub_change_order_lines: company update" ON public.sub_change_order_lines
  FOR UPDATE TO authenticated
  USING     (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "sub_change_order_lines: company delete" ON public.sub_change_order_lines
  FOR DELETE TO authenticated
  USING     (company_id = get_my_company_id());

DROP POLICY IF EXISTS demo_readonly_no_insert ON public.sub_change_order_lines;
DROP POLICY IF EXISTS demo_readonly_no_update ON public.sub_change_order_lines;
DROP POLICY IF EXISTS demo_readonly_no_delete ON public.sub_change_order_lines;
CREATE POLICY demo_readonly_no_insert ON public.sub_change_order_lines
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_update ON public.sub_change_order_lines
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT is_demo_user()) WITH CHECK (NOT is_demo_user());
CREATE POLICY demo_readonly_no_delete ON public.sub_change_order_lines
  AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT is_demo_user());

DROP POLICY IF EXISTS field_no_access_sub_change_order_lines ON public.sub_change_order_lines;
CREATE POLICY field_no_access_sub_change_order_lines ON public.sub_change_order_lines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (get_my_role() <> 'field') WITH CHECK (get_my_role() <> 'field');

-- --- 5. company_settings: fax (CO form header prints "PHONE ... FAX ...") ----

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS fax TEXT;

COMMIT;
