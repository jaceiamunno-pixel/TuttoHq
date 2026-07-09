-- ─────────────────────────────────────────────────────────────────────────
-- 0039: per-section submittal numbering
-- ─────────────────────────────────────────────────────────────────────────
--
-- The log displayed submittal_seq (a per-PROJECT counter) as the submittal
-- number. A row created later in an early section showed as #95 sitting next
-- to #50 — meaningless to a CM and ugly on a transmittal.
--
-- The real convention (and the one already present in imported data, e.g.
-- 092116-001.0 / 092116-002.0) is SECTION + a sequence WITHIN that section:
--   10 44 00-001, 10 44 00-002, ...
--
-- Rules (Jace):
--   • One sequence per (project, csi_section) — ALL types share it. Every
--     number in a section points at exactly one document.
--   • Assigned ONCE at row creation. Permanent. Never renumbered.
--   • Deleting or clearing a row RETIRES its number (gap stays). A number
--     already sent to a CM must never point at a different document.
--   • Backfill SKIPS soft-deleted rows — a row deleted as a mistake never
--     existed as a submittal and shouldn't consume a number.
--
-- submittal_seq stays as the internal row id: never shown, never renumbered.
-- submittal_number is LEGACY and untouched — it currently holds junk
-- ("15", "1", "Applied Fire Protection", "Gypsum Board"). A later cleanup
-- migration drops it once no code reads it.
--
-- Idempotent. Add-only. Backfill only fills NULLs.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE submittals
  ADD COLUMN IF NOT EXISTS section_seq integer;

WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, csi_section
           ORDER BY submittal_seq
         ) AS n
  FROM submittals
  WHERE status <> 'deleted'
    AND csi_section IS NOT NULL
    AND section_seq IS NULL
)
UPDATE submittals s
SET section_seq = numbered.n
FROM numbered
WHERE s.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_submittals_section_seq_unique
  ON submittals(project_id, csi_section, section_seq)
  WHERE section_seq IS NOT NULL;
