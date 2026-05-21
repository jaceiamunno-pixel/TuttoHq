-- ─── Subcontractors & Suppliers ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subcontractors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name   TEXT NOT NULL,
  trade          TEXT,
  contact_name   TEXT,
  phone          TEXT,
  email          TEXT,
  license_number TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  uploaded_by    UUID REFERENCES auth.users(id)
);
ALTER TABLE subcontractors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full subcontractors" ON subcontractors FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  specialty    TEXT,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  website      TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  uploaded_by  UUID REFERENCES auth.users(id)
);
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full suppliers" ON suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS project_subcontractors (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subcontractor_id UUID NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, subcontractor_id)
);
ALTER TABLE project_subcontractors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full project_subcontractors" ON project_subcontractors FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS project_suppliers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, supplier_id)
);
ALTER TABLE project_suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full project_suppliers" ON project_suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE closeout_items ADD COLUMN IF NOT EXISTS folder_name TEXT;

-- ─── RFI table updates ────────────────────────────────────────────────────────
ALTER TABLE rfis
  ADD COLUMN IF NOT EXISTS received_from         TEXT,
  ADD COLUMN IF NOT EXISTS specification_section TEXT,
  ADD COLUMN IF NOT EXISTS location              TEXT,
  ADD COLUMN IF NOT EXISTS schedule_impact       TEXT DEFAULT 'TBD',
  ADD COLUMN IF NOT EXISTS cost_impact           TEXT DEFAULT 'TBD',
  ADD COLUMN IF NOT EXISTS file_path             TEXT,
  ADD COLUMN IF NOT EXISTS file_name             TEXT,
  ADD COLUMN IF NOT EXISTS generated_pdf_path    TEXT,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT now();

-- ─── Change orders table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS change_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           UUID REFERENCES projects(id),
  co_number            TEXT NOT NULL,
  date                 DATE DEFAULT CURRENT_DATE,
  proposal             TEXT,
  qualifications       TEXT,
  pricing_sum          NUMERIC(12,2),
  schedule_impact      TEXT DEFAULT 'TBD',
  schedule_impact_days INTEGER,
  file_path            TEXT,
  file_name            TEXT,
  status               TEXT DEFAULT 'Draft',
  submitted_by         TEXT,
  assigned_to          TEXT,
  generated_pdf_path   TEXT,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  uploaded_by          UUID REFERENCES auth.users(id)
);

-- ─── PDF path columns for punch, daily reports, drawings ─────────────────────
ALTER TABLE punch_items   ADD COLUMN IF NOT EXISTS generated_pdf_path TEXT;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS generated_pdf_path TEXT;
ALTER TABLE drawing_log   ADD COLUMN IF NOT EXISTS generated_pdf_path TEXT;

-- ─── Closeout module ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closeout_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,   -- documents | inspections | financial | training | handover
  item_type         TEXT NOT NULL,   -- om_manual | warranty | inspection | lien_waiver | training | keys | spare_parts | custom | etc.
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'incomplete', -- incomplete | in_progress | complete
  assigned_to       TEXT,
  due_date          DATE,
  file_url          TEXT,            -- storage path
  file_name         TEXT,            -- display name
  notes             TEXT,
  sort_order        INTEGER DEFAULT 0,
  linked_record_id  UUID,            -- optional FK to a record in another table
  linked_record_type TEXT,           -- submittal | rfi | change_order | punch_item | drawing
  completed_at      TIMESTAMPTZ,
  completed_by      UUID REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ DEFAULT now(),
  uploaded_by       UUID REFERENCES auth.users(id)
);

ALTER TABLE closeout_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can select closeout_items"
  ON closeout_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert closeout_items"
  ON closeout_items FOR INSERT TO authenticated WITH CHECK (auth.uid() = uploaded_by);

CREATE POLICY "Authenticated users can update closeout_items"
  ON closeout_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can delete closeout_items"
  ON closeout_items FOR DELETE TO authenticated USING (true);

-- ─── Submittals RLS — allow soft-delete (UPDATE status) ──────────────────────
CREATE POLICY "Authenticated users can update submittals"
  ON submittals FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ─── Transmittal send-to fields on submittals ─────────────────────────────────
ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS send_to_type           TEXT,
  ADD COLUMN IF NOT EXISTS send_to_company        TEXT,
  ADD COLUMN IF NOT EXISTS send_to_contact        TEXT,
  ADD COLUMN IF NOT EXISTS send_to_email          TEXT,
  ADD COLUMN IF NOT EXISTS send_to_phone          TEXT,
  ADD COLUMN IF NOT EXISTS send_to_address        TEXT,
  ADD COLUMN IF NOT EXISTS transmitted_by         TEXT,
  ADD COLUMN IF NOT EXISTS transmitted_by_company TEXT;

-- ─── Construction Managers ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS construction_managers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  uploaded_by  UUID REFERENCES auth.users(id)
);
ALTER TABLE construction_managers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full construction_managers" ON construction_managers FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS project_cms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cm_id      UUID NOT NULL REFERENCES construction_managers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, cm_id)
);
ALTER TABLE project_cms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full project_cms" ON project_cms FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─── Companies (created on signup) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  owner_id   UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth full companies" ON companies FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- =============================================================================
-- MULTI-TENANT ROW LEVEL SECURITY
-- Run this entire block after the above. Safe to re-run (uses IF NOT EXISTS /
-- IF EXISTS / OR REPLACE throughout).
-- =============================================================================

-- ─── 1. user_profiles — maps every auth user to their company ────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id)  ON DELETE CASCADE,
  company_id UUID NOT NULL    REFERENCES companies(id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
-- Users may only see/edit their own profile row
CREATE POLICY "user_profiles: own row" ON user_profiles
  FOR ALL TO authenticated
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─── 2. get_my_company_id() — used by every RLS policy below ─────────────────
-- SECURITY DEFINER so it can read user_profiles bypassing its own RLS.
-- search_path is pinned so it cannot be exploited by a malicious search_path.
CREATE OR REPLACE FUNCTION get_my_company_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
$$;

-- ─── 3. Add company_id column to every tenant-owned table ────────────────────
-- DEFAULT calls get_my_company_id() so API routes need no code changes:
-- Postgres fills the column automatically from the authenticated user's session.

ALTER TABLE projects               ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE submittals             ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE rfis                   ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE change_orders          ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE punch_items            ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE daily_reports          ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE drawing_log            ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE closeout_items         ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE subcontractors         ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE suppliers              ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE construction_managers  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE team_members           ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE gmail_connections      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE project_subcontractors ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE project_suppliers      ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();
ALTER TABLE project_cms            ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();

-- ─── 4. Indexes — one per company_id column for query performance ─────────────
CREATE INDEX IF NOT EXISTS idx_projects_company               ON projects               (company_id);
CREATE INDEX IF NOT EXISTS idx_submittals_company             ON submittals             (company_id);
CREATE INDEX IF NOT EXISTS idx_rfis_company                   ON rfis                   (company_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_company          ON change_orders          (company_id);
CREATE INDEX IF NOT EXISTS idx_punch_items_company            ON punch_items            (company_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_company          ON daily_reports          (company_id);
CREATE INDEX IF NOT EXISTS idx_drawing_log_company            ON drawing_log            (company_id);
CREATE INDEX IF NOT EXISTS idx_closeout_items_company         ON closeout_items         (company_id);
CREATE INDEX IF NOT EXISTS idx_subcontractors_company         ON subcontractors         (company_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_company              ON suppliers              (company_id);
CREATE INDEX IF NOT EXISTS idx_construction_managers_company  ON construction_managers  (company_id);
CREATE INDEX IF NOT EXISTS idx_team_members_company           ON team_members           (company_id);
CREATE INDEX IF NOT EXISTS idx_gmail_connections_company      ON gmail_connections      (company_id);
CREATE INDEX IF NOT EXISTS idx_project_subcontractors_company ON project_subcontractors (company_id);
CREATE INDEX IF NOT EXISTS idx_project_suppliers_company      ON project_suppliers      (company_id);
CREATE INDEX IF NOT EXISTS idx_project_cms_company            ON project_cms            (company_id);

-- ─── 5. Enable RLS on tables that were missing it ─────────────────────────────
ALTER TABLE projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE submittals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfis              ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE punch_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_reports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawing_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;

-- ─── 6. Drop all old permissive policies ─────────────────────────────────────
DROP POLICY IF EXISTS "auth full subcontractors"                          ON subcontractors;
DROP POLICY IF EXISTS "auth full suppliers"                               ON suppliers;
DROP POLICY IF EXISTS "auth full project_subcontractors"                  ON project_subcontractors;
DROP POLICY IF EXISTS "auth full project_suppliers"                       ON project_suppliers;
DROP POLICY IF EXISTS "auth full construction_managers"                   ON construction_managers;
DROP POLICY IF EXISTS "auth full project_cms"                             ON project_cms;
DROP POLICY IF EXISTS "auth full companies"                               ON companies;
DROP POLICY IF EXISTS "Authenticated users can select closeout_items"     ON closeout_items;
DROP POLICY IF EXISTS "Authenticated users can insert closeout_items"     ON closeout_items;
DROP POLICY IF EXISTS "Authenticated users can update closeout_items"     ON closeout_items;
DROP POLICY IF EXISTS "Authenticated users can delete closeout_items"     ON closeout_items;
DROP POLICY IF EXISTS "Authenticated users can update submittals"         ON submittals;

-- ─── 7. Company-scoped RLS policies (4 per table = 68 total) ─────────────────
-- Pattern: every operation checks company_id = get_my_company_id()
-- New rows automatically inherit company_id via column DEFAULT (step 3),
-- so the INSERT WITH CHECK just validates they match.

-- projects
CREATE POLICY "projects: company select" ON projects FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "projects: company insert" ON projects FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "projects: company update" ON projects FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "projects: company delete" ON projects FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- submittals
CREATE POLICY "submittals: company select" ON submittals FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "submittals: company insert" ON submittals FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "submittals: company update" ON submittals FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "submittals: company delete" ON submittals FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- rfis
CREATE POLICY "rfis: company select" ON rfis FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "rfis: company insert" ON rfis FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "rfis: company update" ON rfis FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "rfis: company delete" ON rfis FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- change_orders
CREATE POLICY "change_orders: company select" ON change_orders FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "change_orders: company insert" ON change_orders FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "change_orders: company update" ON change_orders FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "change_orders: company delete" ON change_orders FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- punch_items
CREATE POLICY "punch_items: company select" ON punch_items FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "punch_items: company insert" ON punch_items FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "punch_items: company update" ON punch_items FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "punch_items: company delete" ON punch_items FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- daily_reports
CREATE POLICY "daily_reports: company select" ON daily_reports FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "daily_reports: company insert" ON daily_reports FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "daily_reports: company update" ON daily_reports FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "daily_reports: company delete" ON daily_reports FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- drawing_log
CREATE POLICY "drawing_log: company select" ON drawing_log FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "drawing_log: company insert" ON drawing_log FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "drawing_log: company update" ON drawing_log FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "drawing_log: company delete" ON drawing_log FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- closeout_items
CREATE POLICY "closeout_items: company select" ON closeout_items FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "closeout_items: company insert" ON closeout_items FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_items: company update" ON closeout_items FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_items: company delete" ON closeout_items FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- subcontractors
CREATE POLICY "subcontractors: company select" ON subcontractors FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "subcontractors: company insert" ON subcontractors FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "subcontractors: company update" ON subcontractors FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "subcontractors: company delete" ON subcontractors FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- suppliers
CREATE POLICY "suppliers: company select" ON suppliers FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "suppliers: company insert" ON suppliers FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "suppliers: company update" ON suppliers FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "suppliers: company delete" ON suppliers FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- construction_managers
CREATE POLICY "construction_managers: company select" ON construction_managers FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "construction_managers: company insert" ON construction_managers FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "construction_managers: company update" ON construction_managers FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "construction_managers: company delete" ON construction_managers FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- team_members
CREATE POLICY "team_members: company select" ON team_members FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "team_members: company insert" ON team_members FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "team_members: company update" ON team_members FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "team_members: company delete" ON team_members FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- gmail_connections
CREATE POLICY "gmail_connections: company select" ON gmail_connections FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "gmail_connections: company insert" ON gmail_connections FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "gmail_connections: company update" ON gmail_connections FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "gmail_connections: company delete" ON gmail_connections FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- project_subcontractors
CREATE POLICY "project_subcontractors: company select" ON project_subcontractors FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_subcontractors: company insert" ON project_subcontractors FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_subcontractors: company update" ON project_subcontractors FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_subcontractors: company delete" ON project_subcontractors FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- project_suppliers
CREATE POLICY "project_suppliers: company select" ON project_suppliers FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_suppliers: company insert" ON project_suppliers FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_suppliers: company update" ON project_suppliers FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_suppliers: company delete" ON project_suppliers FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- project_cms
CREATE POLICY "project_cms: company select" ON project_cms FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_cms: company insert" ON project_cms FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_cms: company update" ON project_cms FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_cms: company delete" ON project_cms FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- companies: owner sees only their own company
DROP POLICY IF EXISTS "auth full companies" ON companies;
CREATE POLICY "companies: owner only" ON companies
  FOR ALL TO authenticated
  USING     (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ─── 8. Backfill existing data ────────────────────────────────────────────────
-- IMPORTANT: Run this AFTER you have at least one row in user_profiles
-- (i.e. after at least one user has signed up via the new /signup flow).
--
-- For tables with uploaded_by — backfill from the uploader's company:
UPDATE submittals            SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = submittals.uploaded_by)            WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
UPDATE drawing_log           SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = drawing_log.uploaded_by)           WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
UPDATE change_orders         SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = change_orders.uploaded_by)         WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
UPDATE closeout_items        SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = closeout_items.uploaded_by)        WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
UPDATE subcontractors        SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = subcontractors.uploaded_by)        WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
UPDATE suppliers             SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = suppliers.uploaded_by)             WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
UPDATE construction_managers SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = construction_managers.uploaded_by) WHERE company_id IS NULL AND uploaded_by IS NOT NULL;
--
-- For tables WITHOUT uploaded_by — assign all NULL rows to your company:
-- Replace '<YOUR_COMPANY_ID>' with the UUID from the companies table.
-- SELECT id FROM companies;  -- run this first to find your company UUID
--
-- UPDATE projects          SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE rfis               SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE punch_items        SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE daily_reports      SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE team_members       SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE gmail_connections  SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE project_subcontractors SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE project_suppliers      SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;
-- UPDATE project_cms            SET company_id = '<YOUR_COMPANY_ID>' WHERE company_id IS NULL;

-- =============================================================================
-- COMMITMENTS (executed Subcontracts and Purchase Orders)
-- "From" party is the tenant company (company_id, set by RLS default).
-- "To" party is either a subcontractor (for subcontract type) OR a supplier
-- (for purchase_order type). Exactly one of the two FK columns must be set,
-- and to_company_name stores a stable display snapshot.
-- =============================================================================

CREATE TABLE IF NOT EXISTS commitments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('subcontract','purchase_order')),
  to_subcontractor_id UUID REFERENCES subcontractors(id),
  to_supplier_id      UUID REFERENCES suppliers(id),
  to_company_name     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'executed'
                        CHECK (status IN ('draft','out_for_signature','executed')),
  executed_file_path  TEXT,
  executed_file_name  TEXT,
  executed_at         DATE,
  contract_value      NUMERIC(14,2),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by         UUID REFERENCES auth.users(id),
  company_id          UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  -- Exactly one of the two "to" FKs must be set, and it must match the type.
  CONSTRAINT commitments_to_exactly_one CHECK (
    (to_subcontractor_id IS NOT NULL AND to_supplier_id IS NULL AND type = 'subcontract')
    OR
    (to_supplier_id IS NOT NULL AND to_subcontractor_id IS NULL AND type = 'purchase_order')
  )
);

CREATE INDEX IF NOT EXISTS idx_commitments_project   ON commitments(project_id);
CREATE INDEX IF NOT EXISTS idx_commitments_sub       ON commitments(to_subcontractor_id);
CREATE INDEX IF NOT EXISTS idx_commitments_supplier  ON commitments(to_supplier_id);
CREATE INDEX IF NOT EXISTS idx_commitments_type      ON commitments(type);
CREATE INDEX IF NOT EXISTS idx_commitments_company   ON commitments(company_id);

ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "commitments: company select" ON commitments FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "commitments: company insert" ON commitments FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "commitments: company update" ON commitments FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "commitments: company delete" ON commitments FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- updated_at trigger
CREATE OR REPLACE FUNCTION commitments_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commitments_set_updated_at ON commitments;
CREATE TRIGGER commitments_set_updated_at
  BEFORE UPDATE ON commitments
  FOR EACH ROW EXECUTE FUNCTION commitments_set_updated_at();

-- ─── Commitment scope (commitment ↔ CSI spec section) ────────────────────────
-- Junction table linking a commitment to the CSI sections it covers. Spec
-- section is stored as TEXT (e.g. "033000") to match how submittals/RFIs do
-- it. Hidden from v1 UI; future auto-assignment of submittals will read this.

CREATE TABLE IF NOT EXISTS commitment_scope (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id UUID NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  spec_section  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id    UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  UNIQUE (commitment_id, spec_section)
);

CREATE INDEX IF NOT EXISTS idx_commitment_scope_commitment ON commitment_scope(commitment_id);
CREATE INDEX IF NOT EXISTS idx_commitment_scope_section    ON commitment_scope(spec_section);
CREATE INDEX IF NOT EXISTS idx_commitment_scope_company    ON commitment_scope(company_id);

ALTER TABLE commitment_scope ENABLE ROW LEVEL SECURITY;
CREATE POLICY "commitment_scope: company select" ON commitment_scope FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "commitment_scope: company insert" ON commitment_scope FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "commitment_scope: company update" ON commitment_scope FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "commitment_scope: company delete" ON commitment_scope FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- =============================================================================
-- SPEC BOOK INGESTION
-- Upload a PDF spec book -> split into sections -> extract SUBMITTALS articles
-- -> classify with Claude Haiku -> stage rows for user review -> bulk-commit to
-- the submittals log. Safe to re-run (uses IF NOT EXISTS throughout).
-- =============================================================================

-- --- Project documents (spec books, drawings PDFs, addenda) ------------------
CREATE TABLE IF NOT EXISTS project_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('spec_book','drawings','addendum','other')),
  file_path       TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_size_bytes BIGINT,
  page_count      INT,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by     UUID REFERENCES auth.users(id),
  parsed_at       TIMESTAMPTZ,
  parse_status    TEXT NOT NULL DEFAULT 'pending'
                    CHECK (parse_status IN ('pending','extracting','classifying','parsed','failed')),
  parse_progress  INT  NOT NULL DEFAULT 0,
  parse_error     TEXT,
  company_id      UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_documents_type    ON project_documents(type);
CREATE INDEX IF NOT EXISTS idx_project_documents_company ON project_documents(company_id);

ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_documents: company select" ON project_documents FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_documents: company insert" ON project_documents FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_documents: company update" ON project_documents FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_documents: company delete" ON project_documents FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- Spec sections extracted from a spec book --------------------------------
CREATE TABLE IF NOT EXISTS spec_sections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_document_id UUID NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_number         TEXT NOT NULL,
  spec_title          TEXT NOT NULL,
  start_page          INT,
  end_page            INT,
  full_text           TEXT,
  submittals_text     TEXT,
  has_submittals      BOOLEAN NOT NULL DEFAULT false,
  parsed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id          UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_spec_sections_document ON spec_sections(project_document_id);
CREATE INDEX IF NOT EXISTS idx_spec_sections_project  ON spec_sections(project_id);
CREATE INDEX IF NOT EXISTS idx_spec_sections_number   ON spec_sections(spec_number);
CREATE INDEX IF NOT EXISTS idx_spec_sections_company  ON spec_sections(company_id);

ALTER TABLE spec_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spec_sections: company select" ON spec_sections FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "spec_sections: company insert" ON spec_sections FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "spec_sections: company update" ON spec_sections FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "spec_sections: company delete" ON spec_sections FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- Staged submittals (Haiku output, awaiting user review) ------------------
CREATE TABLE IF NOT EXISTS staged_submittals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_document_id    UUID NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  spec_section_id        UUID NOT NULL REFERENCES spec_sections(id) ON DELETE CASCADE,
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_number            TEXT NOT NULL,
  letter                 TEXT,
  project_item_name      TEXT NOT NULL,
  submittal_type         TEXT NOT NULL CHECK (submittal_type IN
                           ('Product Data','Shop Drawing','Sample','Certification',
                            'Warranty','O&M Manual','Lab Test','Attic Stock','Other')),
  description            TEXT NOT NULL,
  sub_bullets            TEXT[] NOT NULL DEFAULT '{}',
  is_selected            BOOLEAN NOT NULL DEFAULT true,
  committed_at           TIMESTAMPTZ,
  committed_submittal_id UUID REFERENCES submittals(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id             UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_staged_submittals_document ON staged_submittals(project_document_id);
CREATE INDEX IF NOT EXISTS idx_staged_submittals_section  ON staged_submittals(spec_section_id);
CREATE INDEX IF NOT EXISTS idx_staged_submittals_project  ON staged_submittals(project_id);
CREATE INDEX IF NOT EXISTS idx_staged_submittals_company  ON staged_submittals(company_id);

ALTER TABLE staged_submittals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staged_submittals: company select" ON staged_submittals FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "staged_submittals: company insert" ON staged_submittals FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "staged_submittals: company update" ON staged_submittals FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "staged_submittals: company delete" ON staged_submittals FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- Link existing submittals back to source spec section + origin -----------
ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS spec_section_id UUID REFERENCES spec_sections(id),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','gmail','spec_ingestion'));

CREATE INDEX IF NOT EXISTS idx_submittals_spec_section ON submittals(spec_section_id);
CREATE INDEX IF NOT EXISTS idx_submittals_source       ON submittals(source);

-- Spec-ingested submittals have no uploaded file until the sub actually submits,
-- so storage_path must allow NULL. No-op if the column is already nullable.
ALTER TABLE submittals ALTER COLUMN storage_path DROP NOT NULL;

-- Parse telemetry: counts from the most recent parse, so the UI can explain a
-- parse that produced no staged rows — e.g. a multi-volume spec book whose
-- bodies for the scoped divisions live in a different volume.
-- Shape: { sectionsScoped, sectionsFound, sectionsWithSubmittals, staged }
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS parse_summary JSONB;

-- =============================================================================
-- PROJECT SCOPE SECTIONS
-- The set of spec sections a project owns, captured from the spec book's table
-- of contents at project creation. Spec Book Ingestion only classifies sections
-- marked in_scope = true.
--
-- IMPORTANT — legacy behavior: a project with ZERO rows here is treated as
-- "not yet scoped" and ingestion processes ALL sections (see parse/route.ts).
-- Never insert a single marker row for an existing project — one row flips the
-- project into filtered mode and hides every section that lacks a row.
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_scope_sections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Backfilled by Spec Book Ingestion once the real spec_sections row exists.
  -- ON DELETE SET NULL so a re-parse (which deletes spec_sections) keeps scope.
  spec_section_id UUID REFERENCES spec_sections(id) ON DELETE SET NULL,
  spec_number     TEXT NOT NULL,   -- "03 30 00"
  spec_title      TEXT NOT NULL,   -- denormalized for fast queries
  division_code   TEXT NOT NULL,   -- "03"
  in_scope        BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id      UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  UNIQUE (project_id, spec_number)
);

CREATE INDEX IF NOT EXISTS idx_project_scope_sections_project  ON project_scope_sections(project_id);
CREATE INDEX IF NOT EXISTS idx_project_scope_sections_inscope  ON project_scope_sections(project_id, in_scope);
CREATE INDEX IF NOT EXISTS idx_project_scope_sections_company  ON project_scope_sections(company_id);

ALTER TABLE project_scope_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_scope_sections: company select" ON project_scope_sections FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_scope_sections: company insert" ON project_scope_sections FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_scope_sections: company update" ON project_scope_sections FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_scope_sections: company delete" ON project_scope_sections FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- =============================================================================
-- 2026-05-21 — submittals.spec_section_id FK: ON DELETE SET NULL
-- -----------------------------------------------------------------------------
-- The column above (added ~line 588) had no ON DELETE clause, so it defaulted
-- to NO ACTION: deleting a spec_sections row would be blocked while any
-- submittal still referenced it. Re-parsing a spec book deletes and recreates
-- spec_sections, so the link must null out instead of blocking. This was fixed
-- directly in production; this block brings the migration file in sync.
-- Idempotent — safe to re-run.
-- =============================================================================
ALTER TABLE submittals
  DROP CONSTRAINT IF EXISTS submittals_spec_section_id_fkey;
ALTER TABLE submittals
  ADD CONSTRAINT submittals_spec_section_id_fkey
  FOREIGN KEY (spec_section_id) REFERENCES spec_sections(id)
  ON DELETE SET NULL;

-- =============================================================================
-- 2026-05-21 — SUBMITTAL LOG OVERHAUL
-- 12-column tracker columns, per-project sequential number, A/E review dates,
-- vendor links, and a race-safe per-project number allocator.
-- Idempotent — safe to re-run.
-- =============================================================================

-- --- New tracker columns -----------------------------------------------------
-- NOTE: submittal_number already exists as TEXT (the optional cover-sheet
-- number). The per-project sequential tracker number is a distinct column.
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS submittal_seq           INT;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS received_date           DATE;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS sent_to_ae_date         DATE;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS returned_from_ae_date   DATE;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS returned_to_sub_date    DATE;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS submittal_type          TEXT;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS vendor_subcontractor_id UUID REFERENCES subcontractors(id) ON DELETE SET NULL;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS vendor_supplier_id      UUID REFERENCES suppliers(id)      ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_submittals_vendor_sub      ON submittals(vendor_subcontractor_id);
CREATE INDEX IF NOT EXISTS idx_submittals_vendor_supplier ON submittals(vendor_supplier_id);

-- Per-project uniqueness of the sequential number. NULLs are allowed and never
-- conflict, so library uploads with no project (submittal_seq IS NULL) coexist.
-- DEFERRABLE so a future renumber could happen inside one transaction.
ALTER TABLE submittals DROP CONSTRAINT IF EXISTS submittals_project_seq_unique;
ALTER TABLE submittals ADD  CONSTRAINT submittals_project_seq_unique
  UNIQUE (project_id, submittal_seq) DEFERRABLE INITIALLY DEFERRED;

-- --- Backfill ----------------------------------------------------------------
-- Number existing rows per project, ordered by created_at.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at) AS rn
  FROM submittals
  WHERE project_id IS NOT NULL
)
UPDATE submittals s SET submittal_seq = n.rn
FROM numbered n
WHERE s.id = n.id AND s.submittal_seq IS NULL;

-- Recover submittal_type for already-committed spec-ingested submittals (the
-- old commit route discarded it). In consolidated mode every staged row in a
-- group shares one type, so any matching staged row is correct.
UPDATE submittals s SET submittal_type = st.submittal_type
FROM staged_submittals st
WHERE st.committed_submittal_id = s.id AND s.submittal_type IS NULL;

-- --- Fix staged_submittals -> submittals FK ----------------------------------
-- committed_submittal_id had no ON DELETE clause (NO ACTION): a hard delete of
-- a committed submittal (the Reset Submittal Log feature) would be blocked
-- while any staged row still pointed at it. SET NULL instead.
ALTER TABLE staged_submittals
  DROP CONSTRAINT IF EXISTS staged_submittals_committed_submittal_id_fkey;
ALTER TABLE staged_submittals
  ADD CONSTRAINT staged_submittals_committed_submittal_id_fkey
  FOREIGN KEY (committed_submittal_id) REFERENCES submittals(id)
  ON DELETE SET NULL;

-- --- Race-safe per-project sequence allocator --------------------------------
-- A counter row per project. next_submittal_seq() bumps it with a single
-- INSERT ... ON CONFLICT DO UPDATE statement, which row-locks the counter for
-- the statement's duration — concurrent commits serialize and receive disjoint
-- number ranges with no explicit transaction or SELECT ... FOR UPDATE.
CREATE TABLE IF NOT EXISTS project_submittal_counters (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_seq   INT  NOT NULL DEFAULT 0,
  company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

ALTER TABLE project_submittal_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_submittal_counters: company select" ON project_submittal_counters FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_submittal_counters: company insert" ON project_submittal_counters FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_submittal_counters: company update" ON project_submittal_counters FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_submittal_counters: company delete" ON project_submittal_counters FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- Seed counters from existing data. company_id is pulled from the project's
-- submittals (get_my_company_id() would be NULL when run from the SQL editor).
-- (array_agg(...))[1] picks any row's company_id — Postgres has no max(uuid).
INSERT INTO project_submittal_counters (project_id, last_seq, company_id)
SELECT project_id, COALESCE(MAX(submittal_seq), 0), (array_agg(company_id))[1]
FROM submittals
WHERE project_id IS NOT NULL
GROUP BY project_id
ON CONFLICT (project_id) DO UPDATE SET last_seq = EXCLUDED.last_seq;

-- Reserves p_count numbers for a project and returns the seq BEFORE the batch:
-- the caller assigns returned+1 .. returned+p_count.
CREATE OR REPLACE FUNCTION next_submittal_seq(p_project_id UUID, p_count INT)
RETURNS INT
LANGUAGE sql
AS $$
  INSERT INTO project_submittal_counters (project_id, last_seq)
  VALUES (p_project_id, p_count)
  ON CONFLICT (project_id)
  DO UPDATE SET last_seq = project_submittal_counters.last_seq + p_count
  RETURNING last_seq - p_count;
$$;
