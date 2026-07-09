// Section-scoped submittal number formatting.
//
// The user-facing submittal number is `{csi_section}-{section_seq padded to 3}`
// e.g. "10 44 00-004". section_seq is a per-(project, csi_section) counter that
// stays stable for the life of the spec slot — unlike submittal_seq, which is a
// per-PROJECT counter that reads as a meaningless "#95 next to #50" on a
// transmittal. NEVER render submittal_seq as the user-facing number.
//
// section_seq is NULL on deleted rows and on any row created before the
// numbering code landed — those render as "—", never as a fabricated number.

/** Full form: "10 44 00-004". Falls back to the padded seq alone when there's
 *  no section, and to "—" when the row is unnumbered (section_seq NULL). */
export function formatSectionNumber(
  csiSection: string | null | undefined,
  sectionSeq: number | null | undefined,
): string {
  if (sectionSeq == null) return "—"
  const padded = String(sectionSeq).padStart(3, "0")
  const sec = (csiSection ?? "").trim()
  return sec ? `${sec}-${padded}` : padded
}

/** Compact form: the padded seq alone, "004". Use where the section is already
 *  shown in an adjacent column/field (mobile chip, export "Subm #" column beside
 *  a spec-section column, "Sub 004" cross-references). "—" when unnumbered. */
export function padSectionSeq(sectionSeq: number | null | undefined): string {
  return sectionSeq == null ? "—" : String(sectionSeq).padStart(3, "0")
}
