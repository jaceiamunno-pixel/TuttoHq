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
