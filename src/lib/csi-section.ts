// CSI MasterFormat section-shape validation — the ONE place that decides
// whether a string reads as a spec section and what its canonical stored
// form is ("12 66 13", two-digit pairs, single spaces).
//
// Extracted verbatim from bulk-import-form.ts (which keeps importing from
// here) so client components can validate user-typed sections without
// pulling that module's pdf-lib dependency into the browser bundle.

/** Accepts "126613", "12-66-13", "12.66.13", "12 66 13", and the extended
 *  8-digit form ("12 66 13 00" — extra pair ignored). */
export const SECTION_SHAPE = /^\s*(\d{2})[\s.\-]?(\d{2})[\s.\-]?(\d{2})(?:[\s.\-]?\d{2})?\s*$/

/** MasterFormat divisions that actually exist — a shape match whose leading
 *  pair isn't one of these is rejected (guards against dates, part numbers,
 *  project numbers that happen to be 6 digits). */
export const VALID_DIVISIONS_FOR_SHAPE = new Set([
  "00","01","02","03","04","05","06","07","08","09","10","11","12",
  "13","14","21","22","23","25","26","27","28","31","32","33","34",
  "35","40","41","42","43","44","46","48",
])

/** Validate + canonicalize: returns the spaced canonical form ("12 66 13")
 *  or null when the string isn't a plausible MasterFormat section. This is
 *  the format every existing csi_section value is stored in. */
export function canonicalSectionShape(v: string): string | null {
  const m = v.match(SECTION_SHAPE)
  if (!m || !VALID_DIVISIONS_FOR_SHAPE.has(m[1])) return null
  return `${m[1]} ${m[2]} ${m[3]}`
}

export function isSectionShape(v: string): boolean {
  return canonicalSectionShape(v) !== null
}
