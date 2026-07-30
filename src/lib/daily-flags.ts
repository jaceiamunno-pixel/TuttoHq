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
// Flip to true (one-line diff) ONLY after 0050 is confirmed applied via
// introspection. Imported by both API routes and client components.
export const DAILY_0050_LIVE = false
