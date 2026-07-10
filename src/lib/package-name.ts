// Human-readable filenames for transmittal-package artifacts.
//
// A transmittal file is a document a GC emails to a CM/AE — its name is read by
// a person, not a machine. These helpers keep the per-item filename, the log,
// and the coversheet in agreement by reusing `formatSectionNumber` for the
// number, and they deliberately preserve spaces (they read better than "_").
//
// Pure + dependency-free (no pdf-lib / node) so both the server generator and
// the client zip/download UI import from one place.

import { formatSectionNumber } from "./section-number"

// The ONLY characters a filesystem (and a Supabase storage key) truly forbids in
// a path segment: / \ : * ? " < > | plus ASCII control chars. Everything else —
// spaces, hyphens, parens, ampersands — is legal, readable, and kept.
const FORBIDDEN_CLASS = "[/\\\\:*?\"<>|\\u0000-\\u001f]"
// eslint-disable-next-line no-control-regex
const FORBIDDEN = new RegExp(FORBIDDEN_CLASS, "g")

/** Make an arbitrary string safe as ONE filename segment: forbidden chars → a
 *  space, runs of whitespace collapsed, and leading/trailing dots/spaces
 *  trimmed (Windows rejects a trailing dot or space). Extension logic is the
 *  caller's job. */
function safeSegment(s: string): string {
  return (s || "")
    .replace(FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
}

/** Drop a single trailing ".pdf" (case-insensitive) so a title that already
 *  ends in .pdf ("…Product Submittal.pdf") does not yield "….pdf.pdf". */
function stripPdfSuffix(s: string): string {
  return s.replace(/\.pdf\s*$/i, "")
}

/**
 * Filename for ONE transmittal item, agreeing with the log + coversheet number:
 *   "{csi_section}-{section_seq:3} {title}.pdf"
 *   e.g. "07 81 00-001 Applied Fire Protection.pdf"
 *
 * NULL section_seq → the number is omitted ENTIRELY (never a fabricated "001"):
 *   "Applied Fire Protection.pdf".
 * An empty/placeholder title falls back to "Submittal".
 */
export function transmittalItemFileName(
  csiSection: string | null | undefined,
  sectionSeq: number | null | undefined,
  title: string | null | undefined,
): string {
  const rawTitle = stripPdfSuffix((title ?? "").trim())
  // "—" is the resolver's placeholder for a title-less row; treat it as empty.
  const cleanTitle =
    safeSegment(rawTitle === "—" ? "" : rawTitle).slice(0, 120).replace(/[.\s]+$/g, "") || "Submittal"
  // formatSectionNumber returns "—" for a null seq, so only call it when there
  // is a real seq — the null case must yield NO number, not a dash.
  const number = sectionSeq != null ? formatSectionNumber(csiSection, sectionSeq) : ""
  const base = number ? `${number} ${cleanTitle}` : cleanTitle
  return `${base}.pdf`
}

// Recipient labels for artifact NAMES. Slash-free ("/" is forbidden in a
// filename, so A/E becomes "Architect-Engineer").
const ARTIFACT_RECIPIENT_LABEL: Record<string, string> = {
  cm: "Construction Manager",
  ae: "Architect-Engineer",
  subcontractor: "Subcontractor",
}

/**
 * Base name (NO extension) for the package-level artifacts — the single
 * 'package' PDF and the 'per_item' "Download all" zip — so both read the same:
 *   "Submittal Transmittal - {Recipient} - {YYYY-MM-DD}"
 *
 * Falls back to the given tracking ref (the package number) when recipient or
 * date is missing (e.g. legacy solicitation packages).
 */
export function transmittalPackageBaseName(
  recipientType: string | null | undefined,
  sendDate: string | null | undefined,
  fallback: string,
): string {
  const label = recipientType ? ARTIFACT_RECIPIENT_LABEL[recipientType] : undefined
  if (!label || !sendDate) return safeSegment(fallback) || "Submittal Transmittal"
  return safeSegment(`Submittal Transmittal - ${label} - ${sendDate}`)
}
