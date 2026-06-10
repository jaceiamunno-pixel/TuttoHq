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

-- =============================================================================
-- 2026-05-22 — SESSION I: SUBMITTAL PACKAGES (outbound dispatch)
-- The outbound side of the submittal workflow: a PM groups a sub's submittal
-- expectations + the relevant spec-section excerpts into one packaged PDF,
-- dispatches it by email, and inbound replies match back via a [TTQ-…] subject
-- tag. Idempotent — safe to re-run.
-- =============================================================================

-- --- projects.short_id — stable per-company code for the tracking ref --------
-- The tracking ref is TTQ-{short_id}-{package_seq}. short_id only has to be
-- unique within a company, so the tag never aliases another company's project.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS short_id TEXT;

-- Assign a short_id to every project that lacks one (BEFORE INSERT, so new
-- projects get theirs automatically; column defaults are filled before this
-- fires, so NEW.id / NEW.company_id are available).
CREATE OR REPLACE FUNCTION projects_set_short_id() RETURNS trigger AS $$
DECLARE
  cand TEXT;
  n    INT := 0;
BEGIN
  IF NEW.short_id IS NOT NULL AND NEW.short_id <> '' THEN
    RETURN NEW;
  END IF;
  LOOP
    -- 4-char window over the project UUID's hex, shifted on each collision
    cand := UPPER(SUBSTRING(REPLACE(NEW.id::text, '-', '') FROM 1 + n FOR 4));
    EXIT WHEN cand <> '' AND NOT EXISTS (
      SELECT 1 FROM projects
      WHERE short_id = cand
        AND company_id IS NOT DISTINCT FROM NEW.company_id
        AND id <> NEW.id
    );
    n := n + 1;
    IF n > 27 THEN
      cand := UPPER(SUBSTRING(MD5(random()::text) FROM 1 FOR 4));
      EXIT;
    END IF;
  END LOOP;
  NEW.short_id := cand;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_set_short_id ON projects;
CREATE TRIGGER projects_set_short_id
  BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_set_short_id();

-- Backfill existing projects.
DO $$
DECLARE
  p    RECORD;
  cand TEXT;
  n    INT;
BEGIN
  FOR p IN SELECT id, company_id FROM projects WHERE short_id IS NULL OR short_id = '' LOOP
    n := 0;
    LOOP
      cand := UPPER(SUBSTRING(REPLACE(p.id::text, '-', '') FROM 1 + n FOR 4));
      EXIT WHEN cand <> '' AND NOT EXISTS (
        SELECT 1 FROM projects
        WHERE short_id = cand
          AND company_id IS NOT DISTINCT FROM p.company_id
          AND id <> p.id
      );
      n := n + 1;
      IF n > 27 THEN
        cand := UPPER(SUBSTRING(MD5(random()::text) FROM 1 FOR 4));
        EXIT;
      END IF;
    END LOOP;
    UPDATE projects SET short_id = cand WHERE id = p.id;
  END LOOP;
END $$;

-- --- submittal_packages — one dispatched package -----------------------------
CREATE TABLE IF NOT EXISTS submittal_packages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_number       TEXT NOT NULL,                       -- "TTQ-ABCD-7"
  vendor_id            UUID,                                -- null = manual multi-select
  vendor_type          TEXT CHECK (vendor_type IN ('subcontractor','supplier')),
  vendor_name_snapshot TEXT NOT NULL,
  sent_to_email        TEXT NOT NULL,
  dispatched_at        TIMESTAMPTZ,
  dispatched_by        UUID REFERENCES auth.users(id),
  pdf_file_path        TEXT,                                -- generated package PDF
  gmail_thread_id      TEXT,                                -- email thread for replies
  due_date             DATE,
  status               TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','dispatched','partial_received','complete')),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID REFERENCES auth.users(id),
  company_id           UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_submittal_packages_project ON submittal_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_submittal_packages_vendor  ON submittal_packages(vendor_id);
CREATE INDEX IF NOT EXISTS idx_submittal_packages_status  ON submittal_packages(status);
CREATE INDEX IF NOT EXISTS idx_submittal_packages_company ON submittal_packages(company_id);
-- package_number is unique within a company so inbound [TTQ-…] tags resolve to
-- exactly one package.
CREATE UNIQUE INDEX IF NOT EXISTS idx_submittal_packages_number
  ON submittal_packages(company_id, package_number);

ALTER TABLE submittal_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "submittal_packages: company select" ON submittal_packages;
DROP POLICY IF EXISTS "submittal_packages: company insert" ON submittal_packages;
DROP POLICY IF EXISTS "submittal_packages: company update" ON submittal_packages;
DROP POLICY IF EXISTS "submittal_packages: company delete" ON submittal_packages;
CREATE POLICY "submittal_packages: company select" ON submittal_packages FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "submittal_packages: company insert" ON submittal_packages FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "submittal_packages: company update" ON submittal_packages FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "submittal_packages: company delete" ON submittal_packages FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- submittal_package_items — package ↔ submittal junction ------------------
CREATE TABLE IF NOT EXISTS submittal_package_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id   UUID NOT NULL REFERENCES submittal_packages(id) ON DELETE CASCADE,
  submittal_id UUID NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id   UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  UNIQUE (package_id, submittal_id)
);

CREATE INDEX IF NOT EXISTS idx_submittal_package_items_package   ON submittal_package_items(package_id);
CREATE INDEX IF NOT EXISTS idx_submittal_package_items_submittal ON submittal_package_items(submittal_id);
CREATE INDEX IF NOT EXISTS idx_submittal_package_items_company   ON submittal_package_items(company_id);

ALTER TABLE submittal_package_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "submittal_package_items: company select" ON submittal_package_items;
DROP POLICY IF EXISTS "submittal_package_items: company insert" ON submittal_package_items;
DROP POLICY IF EXISTS "submittal_package_items: company update" ON submittal_package_items;
DROP POLICY IF EXISTS "submittal_package_items: company delete" ON submittal_package_items;
CREATE POLICY "submittal_package_items: company select" ON submittal_package_items FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "submittal_package_items: company insert" ON submittal_package_items FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "submittal_package_items: company update" ON submittal_package_items FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "submittal_package_items: company delete" ON submittal_package_items FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- submittals: outbound dispatch + inbound match-back columns --------------
-- sent_to_sub_date  — set on dispatch; starts the sub's prep clock.
-- received_via_package_id — tags a submittal to the package whose [TTQ-…] tag
--   matched an inbound reply. Set on the expected item when match-back auto-
--   links the reply; set on a new orphan row when it cannot. A row carrying
--   this id that is NOT one of the package's items is a "needs review" reply.
-- received_file_name — the filename of the document the sub actually returned,
--   kept separate from file_name (the expectation's description). Doubles as
--   the dedup key so a Pub/Sub redelivery never re-applies a match.
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS sent_to_sub_date        DATE;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS received_via_package_id UUID REFERENCES submittal_packages(id) ON DELETE SET NULL;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS received_file_name      TEXT;
CREATE INDEX IF NOT EXISTS idx_submittals_received_via_package ON submittals(received_via_package_id);

-- --- Race-safe per-project package number allocator --------------------------
-- Mirrors project_submittal_counters / next_submittal_seq().
CREATE TABLE IF NOT EXISTS project_package_counters (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_seq   INT  NOT NULL DEFAULT 0,
  company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_project_package_counters_company ON project_package_counters(company_id);

ALTER TABLE project_package_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_package_counters: company select" ON project_package_counters;
DROP POLICY IF EXISTS "project_package_counters: company insert" ON project_package_counters;
DROP POLICY IF EXISTS "project_package_counters: company update" ON project_package_counters;
DROP POLICY IF EXISTS "project_package_counters: company delete" ON project_package_counters;
CREATE POLICY "project_package_counters: company select" ON project_package_counters FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_package_counters: company insert" ON project_package_counters FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_package_counters: company update" ON project_package_counters FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_package_counters: company delete" ON project_package_counters FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- Bumps the counter and returns the new sequence number. A single
-- INSERT … ON CONFLICT DO UPDATE row-locks the counter for the statement, so
-- concurrent drafts serialize and receive distinct numbers.
CREATE OR REPLACE FUNCTION next_package_seq(p_project_id UUID)
RETURNS INT
LANGUAGE sql
AS $$
  INSERT INTO project_package_counters (project_id, last_seq)
  VALUES (p_project_id, 1)
  ON CONFLICT (project_id)
  DO UPDATE SET last_seq = project_package_counters.last_seq + 1
  RETURNING last_seq;
$$;

-- --- Package status auto-update ----------------------------------------------
-- A dispatched package advances dispatched → partial_received → complete based
-- on how many of its items have a received_date. Drafts are never touched.
CREATE OR REPLACE FUNCTION recompute_package_status(p_package_id UUID)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_total    INT;
  v_received INT;
  v_status   TEXT;
  v_next     TEXT;
BEGIN
  SELECT status INTO v_status FROM submittal_packages WHERE id = p_package_id;
  -- Leave drafts alone — status only auto-advances once dispatched.
  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE s.received_date IS NOT NULL)
    INTO v_total, v_received
  FROM submittal_package_items i
  JOIN submittals s ON s.id = i.submittal_id
  WHERE i.package_id = p_package_id;

  IF v_total = 0 OR v_received = 0 THEN
    v_next := 'dispatched';
  ELSIF v_received < v_total THEN
    v_next := 'partial_received';
  ELSE
    v_next := 'complete';
  END IF;

  UPDATE submittal_packages SET status = v_next
  WHERE id = p_package_id AND status <> v_next;
END $$;

-- Recompute every package that contains a submittal whose received_date changed.
CREATE OR REPLACE FUNCTION submittals_sync_package_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pkg UUID;
BEGIN
  FOR pkg IN SELECT package_id FROM submittal_package_items WHERE submittal_id = NEW.id LOOP
    PERFORM recompute_package_status(pkg);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS submittals_sync_package_status ON submittals;
CREATE TRIGGER submittals_sync_package_status
  AFTER UPDATE OF received_date ON submittals
  FOR EACH ROW
  WHEN (NEW.received_date IS DISTINCT FROM OLD.received_date)
  EXECUTE FUNCTION submittals_sync_package_status();

-- Recompute when items are added to / removed from a package.
CREATE OR REPLACE FUNCTION package_items_sync_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_package_status(COALESCE(NEW.package_id, OLD.package_id));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS package_items_sync_status ON submittal_package_items;
CREATE TRIGGER package_items_sync_status
  AFTER INSERT OR DELETE ON submittal_package_items
  FOR EACH ROW EXECUTE FUNCTION package_items_sync_status();

-- ─── Closeout packages (Session K1) ──────────────────────────────────────────
-- Outbound dispatch of closeout items (warranties, O&M, certifications, etc.)
-- to subs/suppliers. Mirrors submittal_packages — separate tables on purpose,
-- so Session I stays stable production code. The tracking-ref discriminator
-- is the "-CO-" infix in package_number (TTQ-CO-{short_id}-{seq}); inbound
-- match-back routes on that prefix.
--
-- Match-back policy: ALWAYS orphan, never auto-link. Closeout items have no
-- csi_section analog to match against, so every inbound attachment lands in
-- closeout_package_inbound for PM review. The PM "places" each orphan onto
-- an expected item, which copies file metadata onto the closeout_item itself
-- and marks the inbound row 'placed'. Package status is derived from the
-- closeout_items.status of the junction's linked items.

CREATE TABLE IF NOT EXISTS closeout_packages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_number       TEXT NOT NULL,                       -- "TTQ-CO-ABCD-7"
  vendor_id            UUID,                                -- null = manual multi-select
  vendor_type          TEXT CHECK (vendor_type IN ('subcontractor','supplier')),
  vendor_name_snapshot TEXT NOT NULL,
  sent_to_email        TEXT NOT NULL,
  dispatched_at        TIMESTAMPTZ,
  dispatched_by        UUID REFERENCES auth.users(id),
  pdf_file_path        TEXT,                                -- generated package PDF
  gmail_thread_id      TEXT,                                -- email thread for replies
  due_date             DATE,
  status               TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','dispatched','partial_received','complete')),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID REFERENCES auth.users(id),
  company_id           UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_closeout_packages_project ON closeout_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_closeout_packages_vendor  ON closeout_packages(vendor_id);
CREATE INDEX IF NOT EXISTS idx_closeout_packages_status  ON closeout_packages(status);
CREATE INDEX IF NOT EXISTS idx_closeout_packages_company ON closeout_packages(company_id);
-- package_number is unique within a company so inbound [TTQ-CO-…] tags resolve
-- to exactly one package.
CREATE UNIQUE INDEX IF NOT EXISTS idx_closeout_packages_number
  ON closeout_packages(company_id, package_number);

ALTER TABLE closeout_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "closeout_packages: company select" ON closeout_packages;
DROP POLICY IF EXISTS "closeout_packages: company insert" ON closeout_packages;
DROP POLICY IF EXISTS "closeout_packages: company update" ON closeout_packages;
DROP POLICY IF EXISTS "closeout_packages: company delete" ON closeout_packages;
CREATE POLICY "closeout_packages: company select" ON closeout_packages FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "closeout_packages: company insert" ON closeout_packages FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_packages: company update" ON closeout_packages FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_packages: company delete" ON closeout_packages FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- closeout_package_items — package ↔ closeout_item junction --------------
-- Pure junction. No received_* columns: with always-orphan match-back the
-- "received" state is the linked closeout_item.status='complete' (set when
-- the PM places an inbound orphan onto the item).
CREATE TABLE IF NOT EXISTS closeout_package_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        UUID NOT NULL REFERENCES closeout_packages(id) ON DELETE CASCADE,
  closeout_item_id  UUID NOT NULL REFERENCES closeout_items(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id        UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  UNIQUE (package_id, closeout_item_id)
);

CREATE INDEX IF NOT EXISTS idx_closeout_package_items_package ON closeout_package_items(package_id);
CREATE INDEX IF NOT EXISTS idx_closeout_package_items_item    ON closeout_package_items(closeout_item_id);
CREATE INDEX IF NOT EXISTS idx_closeout_package_items_company ON closeout_package_items(company_id);

ALTER TABLE closeout_package_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "closeout_package_items: company select" ON closeout_package_items;
DROP POLICY IF EXISTS "closeout_package_items: company insert" ON closeout_package_items;
DROP POLICY IF EXISTS "closeout_package_items: company update" ON closeout_package_items;
DROP POLICY IF EXISTS "closeout_package_items: company delete" ON closeout_package_items;
CREATE POLICY "closeout_package_items: company select" ON closeout_package_items FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "closeout_package_items: company insert" ON closeout_package_items FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_package_items: company update" ON closeout_package_items FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_package_items: company delete" ON closeout_package_items FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- closeout_package_inbound — orphans awaiting PM review ------------------
-- Every inbound attachment to a [TTQ-CO-…] package lands here. The PM either
-- places it onto an expected closeout_item (status → 'placed') or dismisses
-- it (status → 'dismissed'). Dedup key is (gmail_message_id, file_name) so
-- Pub/Sub redeliveries never re-apply.
CREATE TABLE IF NOT EXISTS closeout_package_inbound (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id               UUID NOT NULL REFERENCES closeout_packages(id) ON DELETE CASCADE,
  file_name                TEXT NOT NULL,
  storage_path             TEXT NOT NULL,
  mime_type                TEXT,
  file_size                BIGINT,
  sender_email             TEXT,
  received_at              TIMESTAMPTZ,
  gmail_message_id         TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','placed','dismissed')),
  placed_closeout_item_id  UUID REFERENCES closeout_items(id) ON DELETE SET NULL,
  placed_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id               UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_closeout_inbound_package ON closeout_package_inbound(package_id);
CREATE INDEX IF NOT EXISTS idx_closeout_inbound_status  ON closeout_package_inbound(status);
CREATE INDEX IF NOT EXISTS idx_closeout_inbound_company ON closeout_package_inbound(company_id);
CREATE INDEX IF NOT EXISTS idx_closeout_inbound_dedup
  ON closeout_package_inbound(gmail_message_id, file_name);

ALTER TABLE closeout_package_inbound ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "closeout_package_inbound: company select" ON closeout_package_inbound;
DROP POLICY IF EXISTS "closeout_package_inbound: company insert" ON closeout_package_inbound;
DROP POLICY IF EXISTS "closeout_package_inbound: company update" ON closeout_package_inbound;
DROP POLICY IF EXISTS "closeout_package_inbound: company delete" ON closeout_package_inbound;
CREATE POLICY "closeout_package_inbound: company select" ON closeout_package_inbound FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "closeout_package_inbound: company insert" ON closeout_package_inbound FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_package_inbound: company update" ON closeout_package_inbound FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "closeout_package_inbound: company delete" ON closeout_package_inbound FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- Race-safe per-project closeout-package number allocator ---------------
-- Mirror of project_package_counters / next_package_seq.
CREATE TABLE IF NOT EXISTS project_closeout_package_counters (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_seq   INT  NOT NULL DEFAULT 0,
  company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

CREATE INDEX IF NOT EXISTS idx_project_closeout_package_counters_company ON project_closeout_package_counters(company_id);

ALTER TABLE project_closeout_package_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_closeout_package_counters: company select" ON project_closeout_package_counters;
DROP POLICY IF EXISTS "project_closeout_package_counters: company insert" ON project_closeout_package_counters;
DROP POLICY IF EXISTS "project_closeout_package_counters: company update" ON project_closeout_package_counters;
DROP POLICY IF EXISTS "project_closeout_package_counters: company delete" ON project_closeout_package_counters;
CREATE POLICY "project_closeout_package_counters: company select" ON project_closeout_package_counters FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "project_closeout_package_counters: company insert" ON project_closeout_package_counters FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_closeout_package_counters: company update" ON project_closeout_package_counters FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "project_closeout_package_counters: company delete" ON project_closeout_package_counters FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

CREATE OR REPLACE FUNCTION next_closeout_package_seq(p_project_id UUID)
RETURNS INT
LANGUAGE sql
AS $$
  INSERT INTO project_closeout_package_counters (project_id, last_seq)
  VALUES (p_project_id, 1)
  ON CONFLICT (project_id)
  DO UPDATE SET last_seq = project_closeout_package_counters.last_seq + 1
  RETURNING last_seq;
$$;

-- --- Closeout package status auto-update ------------------------------------
-- A dispatched closeout package advances dispatched → partial_received →
-- complete based on how many of its junction's closeout_items have
-- status='complete'. Drafts are never touched.
CREATE OR REPLACE FUNCTION recompute_closeout_package_status(p_package_id UUID)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_total    INT;
  v_received INT;
  v_status   TEXT;
  v_next     TEXT;
BEGIN
  SELECT status INTO v_status FROM closeout_packages WHERE id = p_package_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE c.status = 'complete')
    INTO v_total, v_received
  FROM closeout_package_items i
  JOIN closeout_items c ON c.id = i.closeout_item_id
  WHERE i.package_id = p_package_id;

  IF v_total = 0 OR v_received = 0 THEN
    v_next := 'dispatched';
  ELSIF v_received < v_total THEN
    v_next := 'partial_received';
  ELSE
    v_next := 'complete';
  END IF;

  UPDATE closeout_packages SET status = v_next
  WHERE id = p_package_id AND status <> v_next;
END $$;

-- Recompute every closeout package that contains an item whose status changed.
CREATE OR REPLACE FUNCTION closeout_items_sync_package_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pkg UUID;
BEGIN
  FOR pkg IN SELECT package_id FROM closeout_package_items WHERE closeout_item_id = NEW.id LOOP
    PERFORM recompute_closeout_package_status(pkg);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS closeout_items_sync_package_status ON closeout_items;
CREATE TRIGGER closeout_items_sync_package_status
  AFTER UPDATE OF status ON closeout_items
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION closeout_items_sync_package_status();

-- Recompute when items are added to / removed from a closeout package.
CREATE OR REPLACE FUNCTION closeout_package_items_sync_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_closeout_package_status(COALESCE(NEW.package_id, OLD.package_id));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS closeout_package_items_sync_status ON closeout_package_items;
CREATE TRIGGER closeout_package_items_sync_status
  AFTER INSERT OR DELETE ON closeout_package_items
  FOR EACH ROW EXECUTE FUNCTION closeout_package_items_sync_status();

-- ─── submittals.company_id NOT NULL guardrail ───────────────────────────────
-- Guards against the RLS-visibility bug fixed in gmail-intake.ts: a row
-- inserted with company_id = NULL is invisible to every "company select" RLS
-- policy. The submittals.company_id DEFAULT (get_my_company_id()) silently
-- resolves to NULL for any service-role insert (no auth.uid()), so a forgotten
-- company_id used to produce rows that existed but could never be seen.
--
-- NOT NULL turns that silent data loss into a loud INSERT failure. It is SAFE
-- for user-session inserts (the DEFAULT always resolves there) — it only
-- rejects service-role inserts that omit company_id, which is the bug.

-- Backfill (idempotent — safe to re-run; mirrors the section-8 backfill above):
UPDATE submittals SET company_id = (SELECT company_id FROM user_profiles WHERE user_id = submittals.uploaded_by) WHERE company_id IS NULL AND uploaded_by IS NOT NULL;

ALTER TABLE submittals ALTER COLUMN company_id SET NOT NULL;

-- =============================================================================
-- 2026-05-26 — SESSION K2: PACKAGE REMINDERS + GMAIL SELF-LOOP FIX (Phase 1)
-- -----------------------------------------------------------------------------
-- A daily cron sends reminder emails for dispatched-but-incomplete packages
-- (both submittal and closeout). Cadence is company-wide (default {7,14}, max
-- 2 reminders) with per-package overrides + a pause flag.
--
-- Auto-stop relies on existing triggers (Session I + K1): once every package
-- item is fulfilled the package's status flips to 'complete' and the cron's
-- WHERE clause filters it out. No new status fields needed.
--
-- The Gmail self-loop fix (commit 2) intercepts inbound mail whose subject
-- carries a TuttoHQ-issued [TTQ-...] tracking ref AND whose attachments are
-- our own dispatch PDFs being looped back to the connected mailbox. The skip
-- is recorded in gmail_intake_skips so misclassified skips remain auditable.
--
-- company_settings is added properly here — it has existed in production since
-- before this file was written but was never documented in the migration log.
-- Idempotent — safe to re-run.
-- =============================================================================

-- --- company_settings (formalized) ------------------------------------------
-- Pre-existing in production; columns: id, logo_path, cover_page_path,
-- updated_at. company_id was implicit (single-tenant origin) and is now
-- backed by RLS. The reminder columns below sit on the same row.
CREATE TABLE IF NOT EXISTS company_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  logo_path       TEXT,
  cover_page_path TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id      UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);

-- IMPORTANT: company_settings pre-exists in production from before this file
-- documented it. The CREATE TABLE IF NOT EXISTS above is therefore a NO-OP
-- on prod — it does not retroactively add company_id (or any other column)
-- to the existing row. The explicit ALTER below is what actually adds
-- company_id on a live database. The same column appears in the CREATE so
-- a fresh setup gets it from the start; both paths converge on the same shape.
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) DEFAULT get_my_company_id();

-- Backfill: any pre-existing row with NULL company_id inherits the lone
-- company (single-tenant origin). Safe no-op once every row has one.
UPDATE company_settings cs
SET    company_id = (SELECT id FROM companies LIMIT 1)
WHERE  cs.company_id IS NULL
  AND  (SELECT count(*) FROM companies) = 1;

-- One settings row per company. Enforced lazily — production may have a single
-- row with NULL company_id pre-backfill; this index covers the new state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_settings_company
  ON company_settings(company_id) WHERE company_id IS NOT NULL;

ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "company_settings: company select" ON company_settings;
DROP POLICY IF EXISTS "company_settings: company insert" ON company_settings;
DROP POLICY IF EXISTS "company_settings: company update" ON company_settings;
DROP POLICY IF EXISTS "company_settings: company delete" ON company_settings;
CREATE POLICY "company_settings: company select" ON company_settings FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "company_settings: company insert" ON company_settings FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "company_settings: company update" ON company_settings FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "company_settings: company delete" ON company_settings FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- Reminder cadence configuration -----------------------------------------
-- Company-wide defaults: [7,14] days after dispatch, max 2 reminders,
-- text-only (no PDF re-attach). Per-package overrides on submittal_packages
-- and closeout_packages are nullable — NULL means "fall back to company".
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS reminder_cadence_days       INT[]   NOT NULL DEFAULT '{7,14}',
  ADD COLUMN IF NOT EXISTS reminder_max_count          INT     NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS reminder_default_attach_pdf BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE submittal_packages
  ADD COLUMN IF NOT EXISTS reminder_cadence_days INT[],
  ADD COLUMN IF NOT EXISTS reminder_max_count    INT,
  ADD COLUMN IF NOT EXISTS reminder_attach_pdf   BOOLEAN,
  ADD COLUMN IF NOT EXISTS reminders_paused      BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE closeout_packages
  ADD COLUMN IF NOT EXISTS reminder_cadence_days INT[],
  ADD COLUMN IF NOT EXISTS reminder_max_count    INT,
  ADD COLUMN IF NOT EXISTS reminder_attach_pdf   BOOLEAN,
  ADD COLUMN IF NOT EXISTS reminders_paused      BOOLEAN NOT NULL DEFAULT false;

-- --- submittal_package_reminders --------------------------------------------
-- One row per reminder sent. reminder_number is the 1-indexed position within
-- the package's cadence sequence so the cron can compute "next index = count+1"
-- without consulting clock state. Inserted by the cron under service-role; the
-- DEFAULT for company_id resolves to NULL there, so the column is NOT NULL
-- from the start to force callers to set it explicitly (Session I lesson).
CREATE TABLE IF NOT EXISTS submittal_package_reminders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        UUID NOT NULL REFERENCES submittal_packages(id) ON DELETE CASCADE,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_number   INT NOT NULL CHECK (reminder_number > 0),
  channel           TEXT NOT NULL DEFAULT 'gmail' CHECK (channel IN ('gmail')),
  gmail_message_id  TEXT,
  attached_pdf      BOOLEAN NOT NULL DEFAULT false,
  company_id        UUID NOT NULL REFERENCES companies(id),
  UNIQUE (package_id, reminder_number)
);

CREATE INDEX IF NOT EXISTS idx_submittal_package_reminders_package ON submittal_package_reminders(package_id);
CREATE INDEX IF NOT EXISTS idx_submittal_package_reminders_company ON submittal_package_reminders(company_id);
CREATE INDEX IF NOT EXISTS idx_submittal_package_reminders_sent_at ON submittal_package_reminders(sent_at);

ALTER TABLE submittal_package_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "submittal_package_reminders: company select" ON submittal_package_reminders;
-- Read scoped to the user's company. No INSERT/UPDATE/DELETE policies are
-- defined for authenticated — those operations are reserved for the
-- service-role cron, which bypasses RLS by default. App users cannot forge
-- reminder rows.
CREATE POLICY "submittal_package_reminders: company select" ON submittal_package_reminders
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

-- --- closeout_package_reminders ---------------------------------------------
-- Identical shape; separate table on purpose (mirrors the package tables).
CREATE TABLE IF NOT EXISTS closeout_package_reminders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        UUID NOT NULL REFERENCES closeout_packages(id) ON DELETE CASCADE,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_number   INT NOT NULL CHECK (reminder_number > 0),
  channel           TEXT NOT NULL DEFAULT 'gmail' CHECK (channel IN ('gmail')),
  gmail_message_id  TEXT,
  attached_pdf      BOOLEAN NOT NULL DEFAULT false,
  company_id        UUID NOT NULL REFERENCES companies(id),
  UNIQUE (package_id, reminder_number)
);

CREATE INDEX IF NOT EXISTS idx_closeout_package_reminders_package ON closeout_package_reminders(package_id);
CREATE INDEX IF NOT EXISTS idx_closeout_package_reminders_company ON closeout_package_reminders(company_id);
CREATE INDEX IF NOT EXISTS idx_closeout_package_reminders_sent_at ON closeout_package_reminders(sent_at);

ALTER TABLE closeout_package_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "closeout_package_reminders: company select" ON closeout_package_reminders;
CREATE POLICY "closeout_package_reminders: company select" ON closeout_package_reminders
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

-- --- gmail_intake_skips (self-loop + future skip reasons) --------------------
-- The Gmail self-loop fix logs every inbound message it intentionally drops.
-- This gives the team a queryable counter for "how often is our own outbound
-- coming back at us" without leaving the count buried in console logs.
-- Service-role inserts only — the table is read-only from the app.
CREATE TABLE IF NOT EXISTS gmail_intake_skips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id  TEXT NOT NULL,
  subject           TEXT,
  sender_email      TEXT,
  reason            TEXT NOT NULL CHECK (reason IN ('self_loop_skipped')),
  skipped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  UNIQUE (gmail_message_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_gmail_intake_skips_company    ON gmail_intake_skips(company_id);
CREATE INDEX IF NOT EXISTS idx_gmail_intake_skips_reason     ON gmail_intake_skips(reason);
CREATE INDEX IF NOT EXISTS idx_gmail_intake_skips_skipped_at ON gmail_intake_skips(skipped_at);

ALTER TABLE gmail_intake_skips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gmail_intake_skips: company select" ON gmail_intake_skips;
CREATE POLICY "gmail_intake_skips: company select" ON gmail_intake_skips
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

-- --- projects.short_id uniqueness ------------------------------------------
-- The projects_set_short_id BEFORE INSERT trigger walks the project's UUID
-- to find a 4-char short_id with no peer in the same company. The check is
-- a NOT EXISTS subquery, which under READ COMMITTED can let two concurrent
-- inserts in the same company both pass and commit colliding short_ids.
-- With this unique index in place the colliding insert raises a unique
-- violation; the caller (e.g. /api/projects/batch's parallel inserts) gets
-- a per-row error instead of a silent dup. Partial index — NULL short_ids
-- (theoretical, the trigger always sets one) don't participate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_company_short_id
  ON projects (company_id, short_id)
  WHERE short_id IS NOT NULL;

-- --- Multi-user accounts: Phase 1 schema (no behavior change yet) ----------
-- Lays the data model for two-role (admin/member) team accounts with an
-- email-invite join flow built in later phases. Phase 1 adds:
--   - user_profiles.role with backfill to 'admin' for existing users
--   - get_my_role() security-definer helper, mirrors get_my_company_id()
--   - projects.created_by with ON DELETE SET NULL (removing a user
--     preserves their projects; company_id keeps the project owned)
--   - company_invites table with admin-only write RLS
-- No existing routes are role-gated yet. Phase 2 adds gating, Phase 3 the
-- invite UI/API, Phase 4 the token-based accept flow (which will use a
-- security-definer function to read invites by token without a session,
-- not the policies below).

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'
  CHECK (role IN ('admin','member'));

UPDATE user_profiles SET role = 'admin';

CREATE OR REPLACE FUNCTION get_my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM user_profiles WHERE user_id = auth.uid()
$$;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE projects p
SET created_by = (
  SELECT up.user_id FROM user_profiles up WHERE up.company_id = p.company_id LIMIT 1
)
WHERE p.created_by IS NULL;

CREATE TABLE IF NOT EXISTS company_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  token       text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES auth.users(id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_invites_pending_unique
  ON company_invites (company_id, email) WHERE status = 'pending';
-- token is already uniquely indexed via the inline UNIQUE constraint
-- (company_invites_token_key); no extra btree needed.
CREATE INDEX IF NOT EXISTS idx_company_invites_company ON company_invites (company_id);

ALTER TABLE company_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_invites: company select" ON company_invites;
CREATE POLICY "company_invites: company select" ON company_invites
  FOR SELECT TO authenticated
  USING (company_id = get_my_company_id());

DROP POLICY IF EXISTS "company_invites: admin insert" ON company_invites;
CREATE POLICY "company_invites: admin insert" ON company_invites
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() = 'admin');

DROP POLICY IF EXISTS "company_invites: admin update" ON company_invites;
CREATE POLICY "company_invites: admin update" ON company_invites
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'admin');

DROP POLICY IF EXISTS "company_invites: admin delete" ON company_invites;
CREATE POLICY "company_invites: admin delete" ON company_invites
  FOR DELETE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'admin');

-- --- Multi-user accounts: Phase 2 role gating (RLS backstop) ----------------
-- Tightens the company_settings UPDATE policy to require admin role. Route
-- handlers (/api/settings POST, /api/settings/reminders PATCH) enforce this
-- with a clean 403; the policy below is the backstop so any future code path
-- that reaches the table goes through the same gate. INSERT/SELECT/DELETE
-- policies left at company scope: SELECT must work for every member so the
-- Settings page can render the logo + cadence; INSERT only fires on the
-- first save of a new tenant (the user is implicitly admin); DELETE is not
-- used by the app. Project DELETE RLS is intentionally NOT tightened — the
-- creator-or-admin check lives in the route handler only, per the spec.

DROP POLICY IF EXISTS "company_settings: company update" ON company_settings;
CREATE POLICY "company_settings: company update" ON company_settings
  FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id() AND get_my_role() = 'admin')
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() = 'admin');

-- --- Multi-user accounts: Phase 3 — tighten user_profiles RLS + invite-lookup
--
-- !!!  INVARIANT — READ THIS BEFORE TOUCHING user_profiles  !!!
-- user_profiles intentionally has NO INSERT/UPDATE/DELETE policy. PostgreSQL
-- RLS denies any regular-client write as "no policy matches" — which returns
-- successfully with ZERO rows affected and NO error thrown. This is silent
-- by design at the RLS layer. ALL writes must use the service-role admin
-- client (createAdminClient()). If you're adding a user_profiles write,
-- it goes in a SERVER ROUTE with the admin client — never the cookie/anon
-- client. Today's admin-client write sites are:
--   - /api/signup                  (first user creates company + own profile)
--   - /api/invites/accept (Phase 4) (invitee joins existing company)
--   - /api/team/members/...  (Phase 5) (admin changes role or removes member)
-- The cookie-client policy below permits SELECT-own-row only.
--
-- Why the prior policy had to change: the previous "user_profiles: own row"
-- FOR ALL policy with WITH CHECK (user_id = auth.uid()) let a regular client
-- INSERT user_profiles with ANY company_id (cross-tenant data access via
-- get_my_company_id() reading the planted row) and UPDATE their own role to
-- 'admin' (self-promotion). Both are closed by removing all write policies.

DROP POLICY IF EXISTS "user_profiles: own row" ON user_profiles;

CREATE POLICY "user_profiles: select own" ON user_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- get_invite_by_token — used by the public /invite/<token> accept page
-- before any session exists. Returns one row if the token is recognized
-- (so the page can render the right state — pending/expired/accepted/
-- revoked), zero rows if the token is unknown. SECURITY DEFINER + pinned
-- search_path matches get_my_company_id() and get_my_role(). Tokens are
-- 32 random bytes (~256 bits); the "metadata exposure" requires guessing
-- the token first, which is computationally infeasible.
--
-- The accept ROUTE (Phase 4) does its OWN validation against company_invites
-- — this function is for the page's first-render check only.
CREATE OR REPLACE FUNCTION get_invite_by_token(p_token text)
RETURNS TABLE (
  company_name text,
  email        text,
  role         text,
  status       text,
  expired      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.name                  AS company_name,
    ci.email                AS email,
    ci.role                 AS role,
    ci.status               AS status,
    (ci.expires_at < now()) AS expired
  FROM company_invites ci
  JOIN companies c ON c.id = ci.company_id
  WHERE ci.token = p_token
$$;

GRANT EXECUTE ON FUNCTION get_invite_by_token(text) TO anon, authenticated;
-- Tighten the ACL: Postgres default-grants PUBLIC on new functions, but we
-- want the grant set to be intentional (anon + authenticated only).
-- Functionally equivalent — anon already covers unauthenticated callers —
-- but the explicit REVOKE matches the pattern used by accept_invite_link
-- and the Phase 5 functions.
REVOKE EXECUTE ON FUNCTION get_invite_by_token(text) FROM PUBLIC;

-- --- Multi-user accounts: Phase 4 — atomic accept-invite operation ---------
--
-- This function is the security boundary for the invite-accept flow. It
-- validates a 256-bit token, looks up the just-signed-up auth user by the
-- invite's email (not from a session — the caller has no session since the
-- project requires email confirmation), runs the full gate stack, and on
-- success links user_profiles + confirms the email + marks the invite
-- accepted, all in one transaction.
--
-- Why direct UPDATE on auth.users.email_confirmed_at instead of the Auth
-- Admin API: atomicity. The whole accept runs in one DB transaction; if
-- any step fails, none of the writes committed. The auth.users generated
-- column `confirmed_at` = LEAST(email_confirmed_at, phone_confirmed_at)
-- reflects this set automatically, so GoTrue's sign-in check sees the
-- user as confirmed correctly.
--
-- INVARIANT: user_profiles writes happen via service-role / SECURITY DEFINER
-- only. The "user_profiles: select own" RLS policy denies regular-client
-- writes. This function — REVOKEd from anon/authenticated/PUBLIC and
-- GRANTed only to service_role — is the single legitimate INSERT path for
-- invitee user_profiles rows. The /api/invites/accept route's admin client
-- is the only caller.

CREATE OR REPLACE FUNCTION accept_invite_link(p_token text)
RETURNS TABLE (success boolean, error_code text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite   RECORD;
  v_authuser RECORD;
BEGIN
  -- Lock the invite row so two concurrent callers can't both succeed.
  SELECT id, company_id, email, role, status, expires_at, created_at
    INTO v_invite
    FROM company_invites
    WHERE token = p_token
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text; RETURN;
  END IF;
  IF v_invite.status <> 'pending' THEN
    RETURN QUERY SELECT false, v_invite.status::text; RETURN;
  END IF;
  IF v_invite.expires_at <= now() THEN
    RETURN QUERY SELECT false, 'expired'::text; RETURN;
  END IF;

  -- Gate 3a — find the auth user by invite email.
  SELECT id, email_confirmed_at, created_at, banned_until, deleted_at
    INTO v_authuser
    FROM auth.users
    WHERE lower(email) = lower(v_invite.email)
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no_signup'::text; RETURN;
  END IF;

  -- Gate 3a.5 — banned or soft-deleted users must not be relinkable.
  IF v_authuser.banned_until IS NOT NULL OR v_authuser.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'account_unavailable'::text; RETURN;
  END IF;

  -- Gate 3b — user must still be unconfirmed
  -- (closes "hijack confirmed account").
  IF v_authuser.email_confirmed_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'pre_existing_confirmed'::text; RETURN;
  END IF;

  -- Gate 3c — auth user must have been created AT OR AFTER the invite
  -- (closes "hijack pre-existing unconfirmed orphan").
  IF v_authuser.created_at < v_invite.created_at THEN
    RETURN QUERY SELECT false, 'pre_existing_unconfirmed'::text; RETURN;
  END IF;

  -- Gate 4 — no existing user_profiles row for this auth user.
  IF EXISTS (SELECT 1 FROM user_profiles WHERE user_id = v_authuser.id) THEN
    RETURN QUERY SELECT false, 'already_linked'::text; RETURN;
  END IF;

  -- All gates passed. Atomic link + confirm + mark-accepted.
  INSERT INTO user_profiles (user_id, company_id, role)
  VALUES (v_authuser.id, v_invite.company_id, v_invite.role);

  UPDATE auth.users
     SET email_confirmed_at = now()
   WHERE id = v_authuser.id;

  UPDATE company_invites
     SET status = 'accepted', accepted_at = now()
   WHERE id = v_invite.id;

  RETURN QUERY SELECT true, NULL::text; RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION accept_invite_link(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION accept_invite_link(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION accept_invite_link(text) TO service_role;

-- --- Multi-user accounts: Phase 5 — role management + remove user ----------
--
-- Two SECURITY DEFINER functions that share a race-safety pattern:
--   1. Lock all admin rows in the caller's company (FOR UPDATE).
--   2. Re-validate the caller is STILL admin UNDER the lock (they may have
--      been demoted by a concurrent call).
--   3. Read + lock the target row.
--   4. Cross-company guard.
--   5. (When relevant) Re-count admins UNDER the lock and reject if the
--      operation would leave zero admins.
--
-- The FOR UPDATE on admin rows serializes any admin-mutating op per
-- company. Concurrent calls block each other; whichever wins the lock
-- acts on a consistent snapshot. The at-least-one-admin invariant holds
-- in every interleaving — including a spurious-last_admin failure mode
-- if a concurrent accept_invite_link is mid-flight (acceptable).
--
-- INVARIANT: user_profiles writes happen via service-role / SECURITY
-- DEFINER only. The "user_profiles: select own" RLS policy denies
-- regular-client writes. These two functions — GRANTed to `authenticated`
-- so the route's cookie client can call them with the caller's JWT
-- (auth.uid() inside works) — are the sanctioned mutation path for
-- member role changes and removals.

CREATE OR REPLACE FUNCTION set_user_role(p_target_user_id uuid, p_new_role text)
RETURNS TABLE (success boolean, error_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_uid          uuid := auth.uid();
  v_caller_company_id   uuid;
  v_target_company_id   uuid;
  v_target_current_role text;
  v_admin_count         int;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN QUERY SELECT false, 'unauthenticated'::text; RETURN;
  END IF;

  -- Function-level role validation — fail-fast even though the route
  -- pre-validates; the function shouldn't trust its caller.
  IF p_new_role NOT IN ('admin', 'member') THEN
    RETURN QUERY SELECT false, 'invalid_role'::text; RETURN;
  END IF;

  SELECT company_id INTO v_caller_company_id
    FROM user_profiles WHERE user_id = v_caller_uid;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'caller_no_company'::text; RETURN;
  END IF;

  -- Step 1: LOCK all admin rows in the caller's company.
  PERFORM 1 FROM user_profiles
    WHERE company_id = v_caller_company_id AND role = 'admin'
    FOR UPDATE;

  -- Step 2: Re-validate caller is still admin UNDER the lock.
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_id = v_caller_uid AND company_id = v_caller_company_id AND role = 'admin'
  ) THEN
    RETURN QUERY SELECT false, 'not_admin'::text; RETURN;
  END IF;

  -- Step 3: Read + lock the target row.
  SELECT company_id, role INTO v_target_company_id, v_target_current_role
    FROM user_profiles WHERE user_id = p_target_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'target_not_found'::text; RETURN;
  END IF;

  -- Step 4: Cross-company guard.
  IF v_target_company_id <> v_caller_company_id THEN
    RETURN QUERY SELECT false, 'cross_company'::text; RETURN;
  END IF;

  -- Idempotent no-op if already in the requested role.
  IF v_target_current_role = p_new_role THEN
    RETURN QUERY SELECT true, NULL::text; RETURN;
  END IF;

  -- Step 5: Last-admin guard. Count happens HERE — AFTER the FOR UPDATE
  -- on admin rows — so the count reflects state observable under our lock.
  -- Only triggered when DEMOTING an existing admin.
  IF v_target_current_role = 'admin' AND p_new_role = 'member' THEN
    SELECT COUNT(*) INTO v_admin_count
      FROM user_profiles
      WHERE company_id = v_caller_company_id AND role = 'admin';
    IF v_admin_count <= 1 THEN
      RETURN QUERY SELECT false, 'last_admin'::text; RETURN;
    END IF;
  END IF;

  UPDATE user_profiles SET role = p_new_role WHERE user_id = p_target_user_id;

  RETURN QUERY SELECT true, NULL::text; RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION remove_user_from_company(p_target_user_id uuid)
RETURNS TABLE (success boolean, error_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_uid          uuid := auth.uid();
  v_caller_company_id   uuid;
  v_target_company_id   uuid;
  v_target_current_role text;
  v_admin_count         int;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN QUERY SELECT false, 'unauthenticated'::text; RETURN;
  END IF;

  SELECT company_id INTO v_caller_company_id
    FROM user_profiles WHERE user_id = v_caller_uid;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'caller_no_company'::text; RETURN;
  END IF;

  -- Step 1: LOCK all admin rows in the caller's company.
  PERFORM 1 FROM user_profiles
    WHERE company_id = v_caller_company_id AND role = 'admin'
    FOR UPDATE;

  -- Step 2: Re-validate caller is still admin UNDER the lock — same as
  -- set_user_role. Closes the caller-demoted-concurrently race for the
  -- remove path too.
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_id = v_caller_uid AND company_id = v_caller_company_id AND role = 'admin'
  ) THEN
    RETURN QUERY SELECT false, 'not_admin'::text; RETURN;
  END IF;

  -- Step 3: Read + lock the target row.
  SELECT company_id, role INTO v_target_company_id, v_target_current_role
    FROM user_profiles WHERE user_id = p_target_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'target_not_found'::text; RETURN;
  END IF;

  -- Step 4: Cross-company guard.
  IF v_target_company_id <> v_caller_company_id THEN
    RETURN QUERY SELECT false, 'cross_company'::text; RETURN;
  END IF;

  -- Step 5: Last-admin guard. Count UNDER LOCK. Triggers WHENEVER the
  -- target is an admin (removing any admin reduces the admin count by 1).
  IF v_target_current_role = 'admin' THEN
    SELECT COUNT(*) INTO v_admin_count
      FROM user_profiles
      WHERE company_id = v_caller_company_id AND role = 'admin';
    IF v_admin_count <= 1 THEN
      RETURN QUERY SELECT false, 'last_admin'::text; RETURN;
    END IF;
  END IF;

  DELETE FROM user_profiles WHERE user_id = p_target_user_id;

  RETURN QUERY SELECT true, NULL::text; RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_user_role(uuid, text)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_user_role(uuid, text)      FROM anon, service_role;
GRANT  EXECUTE ON FUNCTION set_user_role(uuid, text)      TO authenticated;

REVOKE EXECUTE ON FUNCTION remove_user_from_company(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION remove_user_from_company(uuid) FROM anon, service_role;
GRANT  EXECUTE ON FUNCTION remove_user_from_company(uuid) TO authenticated;

-- --- gmail_connections: close cross-tenant token-read hole -------------------
-- gmail_connections stores per-user Gmail access_token + refresh_token. The
-- table had FIVE policies — `owner` (FOR ALL, auth.uid() = user_id) plus four
-- company-scoped policies (SELECT/INSERT/UPDATE/DELETE on
-- company_id = get_my_company_id()). Because PostgreSQL OR's policies per
-- command, any company member's cookie-client session satisfied the company
-- predicate and could read every other member's tokens — including refresh
-- tokens, enough to impersonate their Gmail indefinitely. Invisible while
-- companies were single-user; exploitable the moment multi-user accounts
-- went live.
--
-- Fix: drop the four company policies. The `owner` policy alone covers every
-- legitimate regular-client path (all read/write sites in the app filter by
-- the caller's own user_id — see /api/gmail/*, /api/auth/gmail/callback,
-- the dispatch routes, /api/invites POST, and getValidToken in lib/gmail.ts).
-- The two paths that need to read another user's tokens — the reminder cron
-- (src/lib/reminders.ts via /api/cron/send-reminders) and Pub/Sub intake
-- (src/lib/gmail-intake.ts) — use the service-role client and bypass RLS
-- entirely, so they're unaffected.

DROP POLICY IF EXISTS "gmail_connections: company select" ON gmail_connections;
DROP POLICY IF EXISTS "gmail_connections: company insert" ON gmail_connections;
DROP POLICY IF EXISTS "gmail_connections: company update" ON gmail_connections;
DROP POLICY IF EXISTS "gmail_connections: company delete" ON gmail_connections;

-- --- storage.objects: tenant-scoped RLS (Step 3 of the storage isolation fix)
--
-- Before: nine bucket-wide policies. submittals' SELECT/INSERT required
-- `bucket_id = 'submittals' AND auth.role() = 'authenticated'` (any
-- authenticated user reaches every object in the bucket). photos and
-- company-assets had NO auth.role() check at all — bucket_id was the only
-- predicate. Only UUID path obscurity kept tenants apart, and /api/upload
-- accepted a client-supplied file_path that could point anywhere, so a
-- path-leakage incident was the gap to tenant data.
--
-- Migration plan that landed this:
--   Step 1: every upload route prepends {company_id}/ to the path (code,
--           commit 2547f54). Old objects untouched; wide RLS still served them.
--   Step 2a: deleted 120 orphan objects (no DB row referenced them).
--   Step 2b: moved 94 existing objects to {company_id}/{old_path} and
--           updated 14 DB columns that pointed at them. (1 row was already
--           prefixed and got skipped.) All 95 remaining objects now have
--           their first folder segment = a real companies.id.
--   Step 3 (this): swap the 9 bucket-wide policies for 12 tenant-scoped
--           ones. Predicate: (storage.foldername(name))[1] = caller's
--           company_id. Service-role calls (cron + Pub/Sub intake +
--           in-route admin clients) bypass RLS — unaffected.

DROP POLICY IF EXISTS "Authenticated users can read files 10p6uh8_0"    ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload files 10p6uh8_0"  ON storage.objects;
DROP POLICY IF EXISTS "auth overwrite 11180r7_0"                        ON storage.objects;
DROP POLICY IF EXISTS "auth overwrite 11180r7_1"                        ON storage.objects;
DROP POLICY IF EXISTS "auth read 11180r7_0"                             ON storage.objects;
DROP POLICY IF EXISTS "auth upload 11180r7_0"                           ON storage.objects;
DROP POLICY IF EXISTS "photos delete"                                   ON storage.objects;
DROP POLICY IF EXISTS "photos read"                                     ON storage.objects;
DROP POLICY IF EXISTS "photos upload"                                   ON storage.objects;

CREATE POLICY "submittals: tenant select" ON storage.objects FOR SELECT TO authenticated
  USING       (bucket_id = 'submittals'      AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "submittals: tenant insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'submittals'      AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "submittals: tenant update" ON storage.objects FOR UPDATE TO authenticated
  USING       (bucket_id = 'submittals'      AND (storage.foldername(name))[1] = public.get_my_company_id()::text)
  WITH CHECK (bucket_id = 'submittals'      AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "submittals: tenant delete" ON storage.objects FOR DELETE TO authenticated
  USING       (bucket_id = 'submittals'      AND (storage.foldername(name))[1] = public.get_my_company_id()::text);

CREATE POLICY "photos: tenant select" ON storage.objects FOR SELECT TO authenticated
  USING       (bucket_id = 'photos'          AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "photos: tenant insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'photos'          AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "photos: tenant update" ON storage.objects FOR UPDATE TO authenticated
  USING       (bucket_id = 'photos'          AND (storage.foldername(name))[1] = public.get_my_company_id()::text)
  WITH CHECK (bucket_id = 'photos'          AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "photos: tenant delete" ON storage.objects FOR DELETE TO authenticated
  USING       (bucket_id = 'photos'          AND (storage.foldername(name))[1] = public.get_my_company_id()::text);

CREATE POLICY "company-assets: tenant select" ON storage.objects FOR SELECT TO authenticated
  USING       (bucket_id = 'company-assets'  AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "company-assets: tenant insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-assets'  AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "company-assets: tenant update" ON storage.objects FOR UPDATE TO authenticated
  USING       (bucket_id = 'company-assets'  AND (storage.foldername(name))[1] = public.get_my_company_id()::text)
  WITH CHECK (bucket_id = 'company-assets'  AND (storage.foldername(name))[1] = public.get_my_company_id()::text);
CREATE POLICY "company-assets: tenant delete" ON storage.objects FOR DELETE TO authenticated
  USING       (bucket_id = 'company-assets'  AND (storage.foldername(name))[1] = public.get_my_company_id()::text);

-- ─── ADR-004: Subcontractors/Suppliers Firm→People restructure ────────────────
-- Additive. Firm = existing subcontractors/suppliers (untouched, incl. legacy
-- contact_name/phone/email). People = new child tables. Submittals gain nullable
-- person FKs alongside the existing firm FKs. See 04 - Decisions/ADR-004.
-- Applied to prod 2026-06-08 (Step 1 DDL, then Step 2 backfill).

-- Step 1 — DDL
CREATE TABLE IF NOT EXISTS subcontractor_people (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subcontractor_id UUID NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  name             TEXT,
  email            TEXT,
  phone            TEXT,
  role             TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  company_id       UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);
ALTER TABLE subcontractor_people ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_subcontractor_people_subcontractor
  ON subcontractor_people (subcontractor_id);
CREATE POLICY "subcontractor_people: company select" ON subcontractor_people
  FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "subcontractor_people: company insert" ON subcontractor_people
  FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "subcontractor_people: company update" ON subcontractor_people
  FOR UPDATE TO authenticated USING     (company_id = get_my_company_id())
                             WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "subcontractor_people: company delete" ON subcontractor_people
  FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

CREATE TABLE IF NOT EXISTS supplier_people (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  role        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  company_id  UUID REFERENCES companies(id) DEFAULT get_my_company_id()
);
ALTER TABLE supplier_people ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_supplier_people_supplier
  ON supplier_people (supplier_id);
CREATE POLICY "supplier_people: company select" ON supplier_people
  FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "supplier_people: company insert" ON supplier_people
  FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "supplier_people: company update" ON supplier_people
  FOR UPDATE TO authenticated USING     (company_id = get_my_company_id())
                             WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "supplier_people: company delete" ON supplier_people
  FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS vendor_subcontractor_person_id UUID
    REFERENCES subcontractor_people(id) ON DELETE SET NULL;
ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS vendor_supplier_person_id UUID
    REFERENCES supplier_people(id) ON DELETE SET NULL;

-- Step 2 — backfill (one 'primary' person per existing firm from its contact_*).
-- Idempotency note: this is a plain INSERT…SELECT; re-running would duplicate.
-- Already applied once to prod (4 subcontractor rows; 0 suppliers).
INSERT INTO subcontractor_people (subcontractor_id, name, email, phone, role, company_id)
SELECT s.id, s.contact_name, s.email, s.phone, 'primary', s.company_id
FROM subcontractors s;

-- ─── ADR-005: Drawing Log v1 (Phase 1 — NO Bluebeam API) ──────────────────────
-- Additive. drawing_sheets (one row per sheet) + drawing_revisions (file
-- versions under a sheet). Company-scoped RLS mirroring subcontractor_people.
-- Circular FK (sheets.current_revision_id <-> revisions.sheet_id) resolved by
-- creating both tables first, then adding the back-ref FK last (nullable,
-- SET NULL). search_vector mirrors the submittals stored-generated pattern.
-- See 04 - Decisions/ADR-005. Applied to prod 2026-06-08.

CREATE TABLE IF NOT EXISTS drawing_sheets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id          UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  discipline          TEXT,
  sheet_number        TEXT,
  title               TEXT,
  current_revision_id UUID,   -- FK added below, after drawing_revisions exists
  search_vector       TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english',
      COALESCE(sheet_number, '') || ' ' ||
      COALESCE(title, '')        || ' ' ||
      COALESCE(discipline, '')
    )
  ) STORED,
  created_at          TIMESTAMPTZ DEFAULT now(),
  uploaded_by         UUID REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS drawing_revisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id       UUID NOT NULL REFERENCES drawing_sheets(id) ON DELETE CASCADE,
  company_id     UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  revision_label TEXT,
  storage_path   TEXT,
  file_sha256    TEXT,
  file_size      BIGINT,
  source         TEXT,   -- 'uploaded' | 'bluebeam-markup' (plain text in v1; no CHECK)
  created_at     TIMESTAMPTZ DEFAULT now(),
  uploaded_by    UUID REFERENCES auth.users(id)
);

ALTER TABLE drawing_sheets
  ADD CONSTRAINT drawing_sheets_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES drawing_revisions(id) ON DELETE SET NULL;

ALTER TABLE drawing_sheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "drawing_sheets: company select" ON drawing_sheets
  FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "drawing_sheets: company insert" ON drawing_sheets
  FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "drawing_sheets: company update" ON drawing_sheets
  FOR UPDATE TO authenticated USING     (company_id = get_my_company_id())
                             WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "drawing_sheets: company delete" ON drawing_sheets
  FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

ALTER TABLE drawing_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "drawing_revisions: company select" ON drawing_revisions
  FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "drawing_revisions: company insert" ON drawing_revisions
  FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "drawing_revisions: company update" ON drawing_revisions
  FOR UPDATE TO authenticated USING     (company_id = get_my_company_id())
                             WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "drawing_revisions: company delete" ON drawing_revisions
  FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

CREATE INDEX IF NOT EXISTS idx_drawing_sheets_project    ON drawing_sheets    (project_id);
CREATE INDEX IF NOT EXISTS idx_drawing_sheets_company    ON drawing_sheets    (company_id);
CREATE INDEX IF NOT EXISTS idx_drawing_sheets_search     ON drawing_sheets    USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_drawing_revisions_sheet   ON drawing_revisions (sheet_id);
CREATE INDEX IF NOT EXISTS idx_drawing_revisions_sha256  ON drawing_revisions (file_sha256);

-- ADR-005 subsystem-1 corrective ALTER (applied to prod 2026-06-08, after
-- ba5e556). Independent read-only review found 3 additive divergences from the
-- agreed subsystem-1 spec. Additive/reversible; existing columns, policies, and
-- indexes left intact.
--   1. drawing_sheets.discipline_prefix — RAW verbatim sheet-number prefix
--      ('S','A','DM','FP'…), never normalized (derived `discipline` stays).
--   2. drawing_revisions.source — DEFAULT 'uploaded', CHECK
--      ('uploaded','bluebeam-markup'), NOT NULL (Phase-2 ready).
--   3. composite (project_id, company_id, sheet_number) lookup index for the
--      subsystem-4 "does this sheet already exist?" check (NOT unique —
--      confirm-first dup handling lands in subsystem 4).
ALTER TABLE drawing_sheets ADD COLUMN IF NOT EXISTS discipline_prefix TEXT;

ALTER TABLE drawing_revisions ALTER COLUMN source SET DEFAULT 'uploaded';
UPDATE drawing_revisions SET source = 'uploaded' WHERE source IS NULL;  -- empty; safety no-op
ALTER TABLE drawing_revisions
  ADD CONSTRAINT drawing_revisions_source_check CHECK (source IN ('uploaded','bluebeam-markup'));
ALTER TABLE drawing_revisions ALTER COLUMN source SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_drawing_sheets_proj_co_num
  ON drawing_sheets (project_id, company_id, sheet_number);

-- ─── Change orders: 3-value status + assigned CO number ──────────────────────
-- Applied to prod 2026-06-08 and verified read-only.
--
-- Item 3 — collapse the 6-value status text vocabulary to 3 and migrate live rows.
--   Old UI values: Draft, Submitted, Under Review, Approved, Rejected, Void.
--   New vocabulary: 'Not submitted', 'Pending', 'Approved'.
--   Row mapping (7 live rows): Draft→Not submitted (2), Under Review→Pending (3),
--   Approved→Approved unchanged (2). Submitted/Rejected/Void had 0 rows.
--   'Approved' kept byte-for-byte — the approved_at auto-stamp, summary cards,
--   and green badge styling all key off that literal string.
ALTER TABLE change_orders ALTER COLUMN status SET DEFAULT 'Not submitted';  -- was 'Draft'
UPDATE change_orders SET status = 'Not submitted' WHERE status = 'Draft';        -- 2 rows
UPDATE change_orders SET status = 'Pending'       WHERE status = 'Under Review';  -- 3 rows
-- Verified post-migration: Approved=2, Pending=3, Not submitted=2; 0 stragglers.
-- Vocabulary lock (added after 0-straggler verification):
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_status_check CHECK (status IN ('Not submitted','Pending','Approved'));

-- Item 4 — assigned/approved CO number, free-text, independent of co_number
-- (which is the PCO running count). Nullable, no default. Reverse: DROP COLUMN.
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS assigned_co_number TEXT;

-- =============================================================================
-- PCO BUILDER -- Phase 0 migration (additive only). Applied to prod 2026-06-10.
-- New: labor_rates, change_order_line_items
-- Alters: change_orders (+5), company_settings (+4), user_profiles (+1 col)
-- New fn: set_my_signature (SECURITY DEFINER -- the sole authenticated write
--   path to user_profiles.signature_storage_path; preserves the invariant that
--   ALL user_profiles writes go through SECURITY DEFINER. No UPDATE policy and
--   no authenticated table/column UPDATE grant are added -- a bare own-row
--   UPDATE policy would have let users self-assign role='admin' since
--   authenticated holds full-column UPDATE on user_profiles per relacl.)
-- Touches no existing columns, CHECKs, or the CO status/realized_amount model.
-- =============================================================================

-- --- 1. labor_rates: company-level rate book (PCOs snapshot from it) ----------
CREATE TABLE IF NOT EXISTS labor_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  role_name   TEXT NOT NULL,
  reg_rate    NUMERIC(10,2),
  ot_rate     NUMERIC(10,2),
  dt_rate     NUMERIC(10,2),
  sort_order  INTEGER,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labor_rates_company ON labor_rates(company_id);

ALTER TABLE labor_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "labor_rates: company select" ON labor_rates;
DROP POLICY IF EXISTS "labor_rates: company insert" ON labor_rates;
DROP POLICY IF EXISTS "labor_rates: company update" ON labor_rates;
DROP POLICY IF EXISTS "labor_rates: company delete" ON labor_rates;
CREATE POLICY "labor_rates: company select" ON labor_rates FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "labor_rates: company insert" ON labor_rates FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "labor_rates: company update" ON labor_rates FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "labor_rates: company delete" ON labor_rates FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- 2. change_order_line_items: pricing backup rows for a PCO ----------------
-- Line total is COMPUTED in app code (never stored). category drives which
-- column group is meaningful. Cascades when its parent change_order is deleted.
CREATE TABLE IF NOT EXISTS change_order_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id  UUID NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  company_id       UUID REFERENCES companies(id) DEFAULT get_my_company_id(),
  category         TEXT NOT NULL CHECK (category IN ('labor','material','subcontractor')),
  description      TEXT,            -- labor: role-name snapshot; material: item; sub: firm/description
  -- labor columns:
  qty_reg          NUMERIC,
  rate_reg         NUMERIC(10,2),
  qty_ot           NUMERIC,
  rate_ot          NUMERIC(10,2),
  qty_dt           NUMERIC,
  rate_dt          NUMERIC(10,2),
  -- material columns:
  qty              NUMERIC,
  unit             TEXT,
  unit_price       NUMERIC(12,2),
  note             TEXT,            -- THP free-text ref col (e.g. "CO #20")
  -- subcontractor columns:
  amount           NUMERIC(12,2),
  sort_order       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coli_change_order ON change_order_line_items(change_order_id);
CREATE INDEX IF NOT EXISTS idx_coli_company      ON change_order_line_items(company_id);

ALTER TABLE change_order_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "coli: company select" ON change_order_line_items;
DROP POLICY IF EXISTS "coli: company insert" ON change_order_line_items;
DROP POLICY IF EXISTS "coli: company update" ON change_order_line_items;
DROP POLICY IF EXISTS "coli: company delete" ON change_order_line_items;
CREATE POLICY "coli: company select" ON change_order_line_items FOR SELECT TO authenticated USING     (company_id = get_my_company_id());
CREATE POLICY "coli: company insert" ON change_order_line_items FOR INSERT TO authenticated WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "coli: company update" ON change_order_line_items FOR UPDATE TO authenticated USING     (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "coli: company delete" ON change_order_line_items FOR DELETE TO authenticated USING     (company_id = get_my_company_id());

-- --- 3. change_orders: additive PCO columns (nullable; no existing col touched)
ALTER TABLE change_orders
  ADD COLUMN IF NOT EXISTS description_of_work  TEXT,
  ADD COLUMN IF NOT EXISTS oh_p_percent         NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS pco_backup_pdf_path  TEXT,
  ADD COLUMN IF NOT EXISTS pco_cover_pdf_path   TEXT,
  ADD COLUMN IF NOT EXISTS has_pco_detail       BOOLEAN NOT NULL DEFAULT false;

-- --- 4. company_settings: cover header + OH&P default (logo_path already exists)
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS address_line1         TEXT,
  ADD COLUMN IF NOT EXISTS address_line2         TEXT,
  ADD COLUMN IF NOT EXISTS phone                 TEXT,
  ADD COLUMN IF NOT EXISTS default_oh_p_percent  NUMERIC(5,4);

-- --- 5. user_profiles: per-user signature image path (RPC write path) --------
-- Storage path is company-scoped: {company_id}/signatures/{user_id}.png.
-- Writes go ONLY through set_my_signature() below, preserving the invariant
-- that every user_profiles write is via a SECURITY DEFINER function. No UPDATE
-- policy / no authenticated UPDATE grant is added (would expose role column).
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS signature_storage_path TEXT;

CREATE OR REPLACE FUNCTION set_my_signature(p_path TEXT)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE user_profiles
  SET signature_storage_path = p_path
  WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION set_my_signature(TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION set_my_signature(TEXT) TO authenticated;
