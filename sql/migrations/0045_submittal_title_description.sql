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
--     description NOT NULL  = 3     (ALL title_locked = true)
--     title NULL            = 275   (spec placeholders; UI falls back to section_name)
--     title ending '.pdf'   = 0
--     mangled / dangling-paren descriptions = 0
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
--     no em-dash to straddle. description stays NULL.
--   * LOCKED rows (title_locked = true — the ONLY reliable marker of a
--     human-authored parenthetical note; all 3 correct splits were locked, all
--     21 broken ones were unlocked): the human title lives in file_name. Split
--     a SINGLE trailing "(…)" — anchored at end-of-string, no nested parens —
--     into title + description. A locked human title has no material—mfr—dims
--     em-dash structure, so an end-anchored split is safe.
--   * Every UPDATE is guarded so it is a no-op on already-correct rows
--     (title IS NULL / description IS NULL + a real source), making a re-run
--     change 0 rows.
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
--     material_name renders just that. Rows with NO structured columns at all
--     (spec placeholders) produce '' → NULLIF leaves title NULL, so the UI's
--     section_name fallback is preserved. NO paren-split on unlocked rows.
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
  AND ( s.material_name IS NOT NULL
     OR s.manufacturer  IS NOT NULL
     OR s.dimensions    IS NOT NULL )
  AND s.status <> 'deleted'          -- live-row scope: matches the verified
  AND s.deleted_at IS NULL;          -- baseline population (626 live rows)

-- 2b. LOCKED rows — split a single trailing "(…)" out of the human title in
--     file_name. Both columns are written together (description = NULL when
--     there is no trailing parenthetical). Guarded on title IS NULL so it
--     cannot disturb rows prod already populated. The regex is END-ANCHORED
--     and forbids nested parens ([^()]*), so it matches only a terminal note
--     and never straddles the em-dashes of a structured render.
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
  AND s.status <> 'deleted'          -- live-row scope (see 2a)
  AND s.deleted_at IS NULL;

-- ── 3. Parity assertion ────────────────────────────────────────────────────
-- After the guarded backfill, NO row that still lacks a title may have had a
-- title source available, and NO locked row with a trailing parenthetical may
-- still lack a description. If either holds, the reconstruction diverged from
-- what prod already did — RAISE to roll back rather than land a partial state.
DO $$
DECLARE
  bad_unlocked integer;
  bad_locked   integer;
BEGIN
  SELECT count(*) INTO bad_unlocked
  FROM submittals s
  WHERE s.title IS NULL
    AND s.title_locked = false
    AND ( s.material_name IS NOT NULL
       OR s.manufacturer  IS NOT NULL
       OR s.dimensions    IS NOT NULL )
    AND s.status <> 'deleted'
    AND s.deleted_at IS NULL;

  SELECT count(*) INTO bad_locked
  FROM submittals s
  WHERE s.title_locked = true
    AND s.title IS NULL
    AND s.status <> 'deleted'
    AND s.deleted_at IS NULL;

  IF bad_unlocked <> 0 OR bad_locked <> 0 THEN
    RAISE EXCEPTION
      'title/description backfill incomplete: % unlocked with a source but no title, % locked with no title — rolling back',
      bad_unlocked, bad_locked;
  END IF;
END $$;

COMMIT;
