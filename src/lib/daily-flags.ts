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

// ─── Migration 0051 activation switch ───────────────────────────────────────
// Auto-context columns (weather jsonb + labor_notes text) land via
// sql/migrations/0051_daily_report_weather.sql — run manually by Jace.
//
// While false: the POST/PATCH routes never write either column, no weather
// fetch runs on create, and the composer hides the "Labor on Site" section —
// the app deploys safely against the pre-0051 schema. The read side needs no
// gate: detail + PDF render weather/labor only when the row carries them.
//
// Flipped to true 2026-08-05: 0051 verified LIVE in prod (weather jsonb +
// labor_notes present, confirmed via introspection).
export const DAILY_0051_LIVE = true
