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
