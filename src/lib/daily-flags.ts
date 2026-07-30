// ─── Migration 0050 activation switch ───────────────────────────────────────
// Single gate for every schema-dependent piece of the Daily Reports flagship
// rebuild (crew jsonb, draft→submitted lifecycle, soft delete, photo
// captions). The columns land via sql/migrations/0050_daily_reports_flagship.sql,
// which Jace runs manually in the Supabase SQL Editor.
//
// While false: no route selects or writes any 0050 column, DELETE stays a
// hard delete, and the UI hides crew / submit / captions — the app deploys
// safely against the pre-0050 schema.
//
// Flipped to true 2026-07-30: 0050 verified LIVE in prod (all 8 columns
// present, 54 legacy reports backfilled 'draft'). Imported by both API
// routes and client components.
export const DAILY_0050_LIVE = true
