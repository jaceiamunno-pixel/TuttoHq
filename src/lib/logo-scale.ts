// Per-tenant company-logo size, expressed as a PERCENTAGE multiplier on each
// PDF engine's existing base logo height (Engine A header = 34pt base, the
// submittal coversheet overrides its base to 42pt; Engine B companyBlock = 52pt
// base). effective maxH = baseMaxH * (scalePct / 100). The 150pt WIDTH cap in
// each engine is intentionally NOT scaled — it stays a fixed distortion guard.
//
// Stored in company_settings.logo_scale_pct (integer, NOT NULL, default 130).
// This module is pure (no pdf-lib / no Node deps) so it is safe to import from
// BOTH the server PDF engines and the client Settings UI.

export const LOGO_SCALE_MIN = 50
export const LOGO_SCALE_MAX = 200
export const LOGO_SCALE_DEFAULT = 130

/** Clamp a stored/incoming logo_scale_pct to the supported 50–200 range.
 *  Non-numeric / missing → the column default (130). Defense in depth: every
 *  read path clamps, even though the slider already enforces the range. */
export function clampLogoScalePct(pct?: number | null): number {
  const n = Math.round(Number(pct))
  if (!Number.isFinite(n)) return LOGO_SCALE_DEFAULT
  return Math.min(LOGO_SCALE_MAX, Math.max(LOGO_SCALE_MIN, n))
}
