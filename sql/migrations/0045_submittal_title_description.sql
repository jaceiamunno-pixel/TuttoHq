-- ─────────────────────────────────────────────────────────────────────────
-- 0045: submittals.title / submittals.description — RETROACTIVE RECORD
-- ─────────────────────────────────────────────────────────────────────────
--
-- NUMBERING NOTE
-- This was requested as "0044" but 0044 is already owned by
-- 0044_orphan_attachment_backfill.sql (merged #128, on origin/master). To
-- avoid a duplicate-number collision this file is 0045. 0039/0040 below refer
-- to the OUT-OF-BAND numbers used in the Supabase SQL Editor, NOT to committed
-- repo files — do not touch 0039_section_seq.sql / 0040_equipment_inventory.sql.
--
-- WHY THIS FILE EXISTS
-- submittals.title and submittals.description are LIVE in prod but appear in
-- NO committed migration. They were applied by hand in the SQL Editor under
-- the labels "0039"/"0040" — numbers already owned in-repo by
-- 0039_section_seq.sql and 0040_equipment_inventory.sql — so the repo has no
-- record of them. An executor reading the repo would infer file_name is still
-- the title column and build against the wrong shape (the same class of gap
-- that produced four inferred-vs-prod divergences on the RFQ build). This file
-- is the retroactive record, reconstructed from LIVE PROD on 2026-07-17.
--
-- IT IS ADD-ONLY AND A NO-OP AGAINST CURRENT PROD. Verified live prod state
-- across 626 live rows (status <> 'deleted' AND deleted_at IS NULL):
--     title NOT NULL        = 351
--     description NOT NULL  = 3     (all title_locked = true)
--     title_locked = true   = 14    (3 with a description, 11 without)
--     title NULL            = 275   (ALL spec_ingestion; UI falls back to section_name)
--     title ending '.pdf'   = 0
--     mangled / dangling-paren descriptions = 0
--
--   By source:
--     spec_ingestion : 538 rows — 263 titled, 275 untitled; 538 have
--                      material_name, 533 of which are an ECHO of section_name.
--     manual         :  88 rows —  88 titled,   0 untitled; 88 have
--                      material_name, 0 an echo of section_name.
--
--   THE GATE IS NOT "has a structured source" (an earlier draft's mistake —
--   it would have fired on 273 echo placeholders and INVENTED titles prod
--   deliberately omits). On spec-ingestion placeholder rows material_name is a
--   redundant COPY of section_name (documented in the 0040 postmortem:
--   "material_name is a redundant copy only on spec-ingestion placeholder
--   rows"). Prod left title NULL exactly on those echo rows so the UI shows
--   section_name once, not twice. Every one of the 275 untitled rows is an echo
--   row (a non-echo row always got a real title), so the correct gate is
--   material_name IS DISTINCT FROM section_name — it fires only where a REAL
--   parsed material differs from the section name.
--
-- The columns already exist and are already populated, so section 1's ADD
-- COLUMN IF NOT EXISTS is a no-op and section 2's guarded UPDATEs change 0
-- rows. Run the dry-run SELECT that ships with this change FIRST — it must
-- return 0 rows. If it returns anything, the reconstruction diverges from
-- live state: REPORT it, do not adjust the logic to force zero.
--
-- WHAT THIS DOES NOT DO
--   * Does NOT modify file_name. file_name is NOT NULL and is still the
--     de-facto title every reader depends on; it is reduced to a real filename
--     only after readers move to title — a later, separate change.
--   * Adds NO CHECK constraints. Does NOT touch review_status, title_locked,
--     material_name, manufacturer, or dimensions.
--   * Does NOT renumber/rename 0039_section_seq.sql or
--     0040_equipment_inventory.sql — they are live and correct under those
--     numbers; the collision is in the Vault's notes, not in the repo.
--
-- RECONSTRUCTED BACKFILL LOGIC (the CORRECTED 0040 logic, not the broken 0039
-- regex). title/description are derived from the already-parsed STRUCTURED
-- columns, never by regexing the file_name concat:
--   * file_name is merely `material_name — manufacturer — dimensions` rendered
--     (see src/app/api/upload/route.ts:89-90: the parts are join(' — ')-ed with
--     a U+2014 em-dash). The 0039 mistake regexed THAT concat with a non-greedy
--     ^(.+?)\s*\((.*)\)\s*$ — it grabbed the first '(' and last ')', straddled
--     the em-dashes, and over-fired on 21 of 24 rows leaving dangling parens.
--   * UNLOCKED rows: title = the structured render itself (em-dash join of the
--     parsed columns), trailing '.pdf' stripped. NO paren-split — so there is
--     no em-dash to straddle. description stays NULL. Fires ONLY where
--     material_name IS DISTINCT FROM section_name, so echo placeholders (where
--     material_name is a copy of section_name) are left title NULL and the UI
--     keeps showing section_name once.
--   * LOCKED rows (title_locked = true — the ONLY reliable marker of a
--     human-authored parenthetical note; all 3 correct splits were locked, all
--     21 broken ones were unlocked): the human title lives in file_name. Split
--     a SINGLE trailing "(…)" — anchored at end-of-string, no nested parens —
--     into title + description. A locked human title has no material—mfr—dims
--     em-dash structure, so an end-anchored split is safe. The SAME echo gate
--     applies: the 2 locked rows prod leaves title NULL are locked echo
--     placeholders (material_name = section_name), so material_name IS DISTINCT
--     FROM section_name keeps 2b a no-op on them (see deliverable (d)).
--   * Every UPDATE is guarded so it is a no-op on already-correct rows
--     (title IS NULL / description IS NULL + a non-echo material), making a
--     re-run change 0 rows.
--   * Both UPDATEs are scoped to LIVE rows (status <> 'deleted' AND
--     deleted_at IS NULL) — the exact population the verified counts came from,
--     so "dry-run returns 0" is provable against those 626 live rows and
--     soft-deleted rows are never disturbed.
--
-- IDEMPOTENT. Re-running changes nothing.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Columns (retroactive record) ───────────────────────────────────────
-- No-op on prod: both already exist. Nullable, no default — matching prod
-- (both are the last two columns in submittals' ordinal order).
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS title       text;
ALTER TABLE submittals ADD COLUMN IF NOT EXISTS description text;

-- ── 2. Backfill (guarded; no-op on current prod) ───────────────────────────

-- 2a. UNLOCKED rows — title = the structured render, trailing '.pdf' stripped.
--     Source = the parsed columns joined with ' — ' (U+2014), exactly as
--     file_name is composed. concat_ws skips NULLs, so a row with only
--     material_name renders just that. NO paren-split on unlocked rows.
--
--     ECHO GATE: fire ONLY where material_name IS DISTINCT FROM section_name.
--     On spec-ingestion placeholder rows material_name is a redundant copy of
--     section_name; prod leaves those title NULL so the UI falls back to
--     section_name (rendering it twice would be the bug). All 275 untitled rows
--     are echo rows, so this gate excludes every one of them — the earlier
--     "has a structured source" predicate wrongly fired on 273 of them.
UPDATE submittals AS s
SET title = NULLIF(
      regexp_replace(
        concat_ws(' — ', s.material_name, s.manufacturer, s.dimensions),
        '\.pdf\s*$', '', 'i'
      ),
      ''
    )
WHERE s.title IS NULL
  AND s.title_locked = false
  AND s.material_name IS DISTINCT FROM s.section_name  -- exclude echo placeholders
  AND s.status <> 'deleted'          -- live-row scope: matches the verified
  AND s.deleted_at IS NULL;          -- baseline population (626 live rows)

-- 2b. LOCKED rows — split a single trailing "(…)" out of the human title in
--     file_name. Both columns are written together (description = NULL when
--     there is no trailing parenthetical). Guarded on title IS NULL so it
--     cannot disturb rows prod already populated. The regex is END-ANCHORED
--     and forbids nested parens ([^()]*), so it matches only a terminal note
--     and never straddles the em-dashes of a structured render.
--
--     SAME ECHO GATE as 2a: the 2 locked rows prod leaves title NULL are locked
--     echo placeholders (material_name = section_name). material_name IS
--     DISTINCT FROM section_name excludes them, so 2b changes 0 rows on current
--     prod. Without it 2b would fire on those 2 (bad_locked = 2) — inventing a
--     section-name title on a placeholder a human deliberately locked.
UPDATE submittals AS s
SET
  title = NULLIF(
    regexp_replace(
      regexp_replace(s.file_name, '\s*\([^()]*\)\s*$', ''),  -- drop trailing (note)
      '\.pdf\s*$', '', 'i'                                    -- strip .pdf
    ),
    ''
  ),
  description = NULLIF(
    btrim((regexp_match(s.file_name, '\(([^()]*)\)\s*$'))[1]),  -- capture note
    ''
  )
WHERE s.title_locked = true
  AND s.title IS NULL
  AND s.material_name IS DISTINCT FROM s.section_name  -- exclude locked echo placeholders
  AND s.status <> 'deleted'          -- live-row scope (see 2a)
  AND s.deleted_at IS NULL;

-- ── 3. Parity assertion ────────────────────────────────────────────────────
-- After the guarded backfill, NO row with a NON-ECHO material may still lack a
-- title (whether locked or not). Echo placeholders are EXCLUDED here exactly as
-- they are in 2a/2b — they are meant to stay title NULL. If either count is
-- nonzero, the reconstruction diverged from what prod already did — RAISE to
-- roll back rather than land a partial state. On current prod both are 0.
DO $$
DECLARE
  bad_unlocked integer;
  bad_locked   integer;
BEGIN
  SELECT count(*) INTO bad_unlocked
  FROM submittals s
  WHERE s.title IS NULL
    AND s.title_locked = false
    AND s.material_name IS DISTINCT FROM s.section_name
    AND s.status <> 'deleted'
    AND s.deleted_at IS NULL;

  SELECT count(*) INTO bad_locked
  FROM submittals s
  WHERE s.title_locked = true
    AND s.title IS NULL
    AND s.material_name IS DISTINCT FROM s.section_name
    AND s.status <> 'deleted'
    AND s.deleted_at IS NULL;

  IF bad_unlocked <> 0 OR bad_locked <> 0 THEN
    RAISE EXCEPTION
      'title/description backfill incomplete: % unlocked non-echo without title, % locked non-echo without title — rolling back',
      bad_unlocked, bad_locked;
  END IF;
END $$;

COMMIT;
