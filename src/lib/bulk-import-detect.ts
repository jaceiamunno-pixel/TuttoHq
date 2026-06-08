// ─── Bulk Import — Stage 1 detection helpers ────────────────────────────────
//
// Per the design page "Bulk Import — Approved Submittals (Design)"
// (RESOLVED 2026-06-01), each dropped signed PDF gets THREE suggestions
// surfaced for human confirm BEFORE anything is committed:
//
//   1. Spec section — filename for the instant suggestion (two conventions:
//      newer `..._SUB_102600_5_...` → "10 26 00"; older
//      `..._08000006_R1_...` → first 6 digits = section).
//      Page-2 "Spec Section No." confirms / corrects.
//   2. Submittal type — mapped to the FIXED vocabulary (Product Data,
//      Shop Drawing, Certification, O&M Manual, Sample, Lab Test, Other,
//      Warranty, Attic Stock). Unclear → "Other" or null-for-confirm,
//      always flagged. NEVER free text.
//   3. Coversheet split — leading run of pages matching one of two
//      template fingerprints (architect review sheet + submitter
//      coversheet). Stops at the first page matching NEITHER. ~1-in-10
//      cover pages are scanned with no extractable text — those are
//      detected as "leading page with low text" and flagged uncertain
//      rather than guessed.
//
// This module is pure: no I/O, no DB, no Storage. It takes a filename and
// an array of per-page text strings and returns the analysis. Stage 1
// commits nothing; Stage 2 (separate change) will consume these outputs.

import { divisionNameFor } from "./spec-parser"
import type { CoversheetFieldsConfidence, FieldConfidence, RawFormFields, ApprovalStampInfo } from "./bulk-import-form"

// ─── Fixed vocabulary ───────────────────────────────────────────────────────

/** Live submittal-type vocabulary. Matches the values present in production
 *  (`submittals.submittal_type` text column, app-enforced — no DB enum).
 *  This is the importer's guardrail against drift. */
export const SUBMITTAL_TYPES = [
  "Product Data",
  "Shop Drawing",
  "Design Mix",
  "Certification",
  "O&M Manual",
  "Sample",
  "Lab Test",
  "Other",
  "Warranty",
  "Attic Stock",
] as const

export type SubmittalType = (typeof SUBMITTAL_TYPES)[number]

const SUBMITTAL_TYPES_SET = new Set<string>(SUBMITTAL_TYPES)

export function isSubmittalType(v: unknown): v is SubmittalType {
  return typeof v === "string" && SUBMITTAL_TYPES_SET.has(v)
}

// ─── Spec-section parsing (filename) ────────────────────────────────────────

// MasterFormat divisions that actually exist. Any 6-digit candidate whose
// leading two digits aren't one of these is rejected — guards against random
// 6-digit runs (dates, part numbers, BAM project numbers, etc.).
const VALID_DIVISIONS = new Set([
  "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12",
  "13", "14", "21", "22", "23", "25", "26", "27", "28", "31", "32", "33", "34",
  "35", "40", "41", "42", "43", "44", "46", "48",
])

function isValidSpecCandidate(six: string): boolean {
  if (six.length !== 6 || !/^\d{6}$/.test(six)) return false
  return VALID_DIVISIONS.has(six.slice(0, 2))
}

/** Normalize a 6-digit candidate `"102600"` → `"10 26 00"`. */
function formatSection(six: string): string {
  return `${six.slice(0, 2)} ${six.slice(2, 4)} ${six.slice(4, 6)}`
}

export interface FilenameSectionGuess {
  section: string | null
  /** Which convention produced the hit, for telemetry / debugging. */
  source: "newer-sub" | "older-8digit" | "loose-6digit" | "none"
}

/**
 * Parse a spec section from the filename. Tries (in order):
 *
 *   1. Newer convention: `_SUB_(\d{6})_` (case-insensitive).
 *   2. Older convention: any 8-digit run — take the first 6 as the section.
 *   3. Loose fallback: any 6-digit run not adjacent to more digits.
 *
 * Each candidate is validated: the leading two digits must be a real
 * MasterFormat division (rejects e.g. BAM project numbers like 08-100-070
 * that look 6-digit-ish).
 *
 * For (2) and (3) we iterate ALL matches and take the first whose leading
 * 6 digits pass the division check — older THP filenames carry a
 * `YYYYMMDD_NNNNNNNN_` prefix where the date matches first but isn't a
 * section (`20251014` → leading "20" is not a valid division). The next
 * 8-digit run (`08000006`) is the real one.
 */
export function parseSectionFromFilename(filename: string): FilenameSectionGuess {
  const base = filename.replace(/\.[^./\\]+$/, "")

  // 1. Newer: ..._SUB_XXXXXX_...
  const newer = base.match(/_SUB_(\d{6})_/i)
  if (newer && isValidSpecCandidate(newer[1])) {
    return { section: formatSection(newer[1]), source: "newer-sub" }
  }

  // 2. Older: 8-digit run, first 6 = section, last 2 = submittal number.
  //    Iterate every candidate; the first one might be a date.
  for (const m of base.matchAll(/(?<!\d)(\d{8})(?!\d)/g)) {
    const six = m[1].slice(0, 6)
    if (isValidSpecCandidate(six)) {
      return { section: formatSection(six), source: "older-8digit" }
    }
  }

  // 3. Loose: any 6-digit run not adjacent to more digits. Iterate.
  for (const m of base.matchAll(/(?<!\d)(\d{6})(?!\d)/g)) {
    if (isValidSpecCandidate(m[1])) {
      return { section: formatSection(m[1]), source: "loose-6digit" }
    }
  }

  return { section: null, source: "none" }
}

// ─── Spec-section from form-field value ─────────────────────────────────────

/**
 * Normalize a free-form Spec Section value that a user typed into a PDF
 * form field. Accepts "10 26 00", "102600", "10-26-00", "10.26.00", etc.
 * Returns the canonical `XX YY ZZ` shape or null if the value isn't a
 * valid MasterFormat section.
 *
 * NOTE: a form-typed value is more authoritative than any text-scrape
 * pattern — it's what the human actually entered on the coversheet —
 * so callers should treat this as the primary section source.
 */
export function normalizeSpecSection(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, "")
  if (digits.length === 8) {
    const six = digits.slice(0, 6)
    if (isValidSpecCandidate(six)) return formatSection(six)
  }
  if (digits.length === 6 && isValidSpecCandidate(digits)) {
    return formatSection(digits)
  }
  return null
}

// ─── Recovered coversheet fields (from PDF AcroForm widgets) ────────────────
//
// THP signed submittals are fillable AcroForm PDFs — the static labels
// ("Spec Section No.", "Date Submitted", …) live in the text content stream
// but the user-typed values live in form-widget annotations. Text-stream
// extraction (unpdf, pdf-parse) only sees labels; pdf-lib's getForm() is the
// only way to recover the actual values without OCR. The /api/bulk-import/
// analyze route reads these fields BEFORE any analysis runs, and Stage 2
// (commit/strip) must ALSO read them before stripping — never strip then
// read, or the form data is gone.

export interface CoversheetFields {
  /** Raw values keyed by canonical field name. Null when not found. */
  specSectionNo:    string | null
  specSectionTitle: string | null
  submittalNo:      string | null
  /** Raw text from the form, not yet normalized. Use normalizeApprovalDate. */
  dateSubmitted:    string | null
  /** The owner-side identifier (BAM template) — usually the project /
   *  facility name. May be null on templates that don't carry it. */
  projectName:      string | null
  /** The submitter / GC the form was completed by (Waters template).
   *  Null on the BAM template, which doesn't include this. */
  submitter:        string | null
}

/** Which coversheet form template a recovery saw. Each template has a
 *  fixed Text-field-name → meaning map, so this drives the extractor. */
export type CoversheetTemplate = "waters" | "bam-thp" | "unknown"

const MONTH_NAMES_NORM = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
]
function monthIndexFromName(s: string): number {
  const prefix = s.slice(0, 3).toLowerCase()
  return MONTH_NAMES_NORM.findIndex(n => n.startsWith(prefix))
}

/** Normalize a free-form date the user typed into the coversheet's
 *  "Date Submitted" or architect-stamp date field to YYYY-MM-DD. Handles
 *  the common THP/BAM shapes:
 *
 *     12/02/2025           (US numeric)
 *     12/2/25              (US numeric, short year)
 *     2025-12-02           (ISO)
 *     29 Dec 2025          (THP architect-stamp shape)
 *     Dec 29, 2025         (alternate)
 *
 *  Returns null if the shape can't be parsed unambiguously — the user
 *  will confirm in the review row either way. */
export function normalizeApprovalDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // US M/D/YYYY or MM/DD/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, mo, d, y] = m
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  // US M/D/YY → assume 20YY for YY <= 50, 19YY otherwise
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)
  if (m) {
    const [, mo, d, y] = m
    const fullY = parseInt(y, 10) <= 50 ? "20" + y : "19" + y
    return `${fullY}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  // "29 Dec 2025" / "29 December 2025"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/)
  if (m) {
    const [, d, mn, y] = m
    const mi = monthIndexFromName(mn)
    if (mi >= 0) return `${y}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  // "Dec 29, 2025" / "December 29 2025"
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m) {
    const [, mn, d, y] = m
    const mi = monthIndexFromName(mn)
    if (mi >= 0) return `${y}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  return null
}

// ─── Spec-section confirmation (page 2 text) ────────────────────────────────

/**
 * Read the printed "Spec Section No." off the submitter coversheet. The
 * label appears on page 2 in the THP/BAM template; we accept a few minor
 * variants and search the supplied page text.
 *
 * Accepts: "Spec Section No.", "Spec Section No", "Spec Section #",
 *          "Specification Section No.", "Specification Section #", etc.
 *
 * The number on the page is either `XX XX XX` or a 6/8-digit run. We
 * normalize to `XX XX XX` for downstream comparison.
 */
export function parseSectionFromPageText(pageText: string): string | null {
  if (!pageText) return null

  // Try a labeled match first — much higher confidence than a bare 6-digit.
  // Allow noise between label and value: punctuation, whitespace, "No.", "#".
  const labeled = pageText.match(
    /(?:Spec(?:ification)?\s+Section)\s*(?:No\.?|#|Number)?\s*[:\-]?\s*(\d{2}\s?\d{2}\s?\d{2}|\d{8}|\d{6})/i,
  )
  if (labeled) {
    const raw = labeled[1].replace(/\s+/g, "")
    if (raw.length === 8) {
      const six = raw.slice(0, 6)
      if (isValidSpecCandidate(six)) return formatSection(six)
    } else if (raw.length === 6 && isValidSpecCandidate(raw)) {
      return formatSection(raw)
    }
  }

  return null
}

// ─── Submittal-type detection ───────────────────────────────────────────────

/** Ordered match list — first wins. Word-boundary anchored on the value so
 *  "SDP" doesn't match "SD"; "Productive" doesn't match "Product Data". */
const TYPE_HINTS: { re: RegExp; type: SubmittalType }[] = [
  // Long forms first — they should win over abbreviations.
  { re: /\bProduct\s*Data\b/i,    type: "Product Data" },
  { re: /\bShop\s*Drawings?\b/i,  type: "Shop Drawing" },
  { re: /\bDesign\s*Mix(?:es|tures?)?\b/i, type: "Design Mix" },
  { re: /\bConcrete\s+Mix(?:\s+Design)?\b/i, type: "Design Mix" },
  { re: /\bO\s*&\s*M\b/i,         type: "O&M Manual" },
  { re: /\bO\s*and\s*M\b/i,       type: "O&M Manual" },
  { re: /\bOperation(?:s)?\s+(?:and|&)\s+Maintenance\b/i, type: "O&M Manual" },
  { re: /\bMaintenance\s+Manual\b/i, type: "O&M Manual" },
  { re: /\bCertif(?:ication|icate|ied)\b/i, type: "Certification" },
  { re: /\bLab(?:oratory)?\s+(?:Test|Report)\b/i, type: "Lab Test" },
  { re: /\bTest\s+Report\b/i,     type: "Lab Test" },
  { re: /\bWarranty\b/i,          type: "Warranty" },
  { re: /\bAttic\s*Stock\b/i,     type: "Attic Stock" },
  { re: /\bSpare\s+(?:Parts|Materials?)\b/i, type: "Attic Stock" },
  { re: /\bSamples?\b/i,          type: "Sample" },
  { re: /\bFinish(?:es)?\b/i,     type: "Sample" },
  { re: /\bMock[- ]?up\b/i,       type: "Sample" },
  // Abbreviations LAST — only fire when no long form matched. Anchored with
  // separators so they don't sneak into longer tokens. Filenames often use
  // _PD_ / _SD_ between underscores; we accept hyphens, dots, spaces, and
  // start/end markers as boundaries.
  { re: /(?:^|[\s_\-.\/])PD(?:[\s_\-.\/]|$)/,     type: "Product Data" },
  { re: /(?:^|[\s_\-.\/])SD(?:[\s_\-.\/]|$)/,     type: "Shop Drawing" },
  { re: /(?:^|[\s_\-.\/])OM(?:[\s_\-.\/]|$)/,     type: "O&M Manual" },
  { re: /(?:^|[\s_\-.\/])CERT(?:[\s_\-.\/]|$)/i,  type: "Certification" },
  { re: /(?:^|[\s_\-.\/])LT(?:[\s_\-.\/]|$)/,     type: "Lab Test" },
  { re: /(?:^|[\s_\-.\/])WAR(?:[\s_\-.\/]|$)/i,   type: "Warranty" },
]

export interface SubmittalTypeGuess {
  type: SubmittalType | null
  /** True when we found a real hint. False = no signal, caller should flag. */
  confident: boolean
  source: "filename" | "page-text" | "form-value" | "none"
}

/**
 * Map filename + early-page coversheet text onto the fixed vocabulary.
 * Filename hints win when present (they're the project-team-supplied label);
 * page-text hints fill in when the filename is uninformative.
 *
 * Filenames typically use underscores / hyphens / dots between tokens — `\b`
 * doesn't treat underscores as word boundaries, so we normalize separators to
 * spaces before matching. Page text already has natural whitespace.
 *
 * Returns `{ type: null, confident: false, source: "none" }` for true
 * unknowns — the caller should flag the row and let the user pick.
 */
function normalizeFilenameForMatch(s: string): string {
  return s.replace(/\.[^./\\]+$/, "").replace(/[_\-.]+/g, " ")
}

export function detectSubmittalType(
  filename: string,
  coverPageText: string,
): SubmittalTypeGuess {
  const base = normalizeFilenameForMatch(filename)

  for (const { re, type } of TYPE_HINTS) {
    if (re.test(base)) return { type, confident: true, source: "filename" }
  }
  if (coverPageText) {
    for (const { re, type } of TYPE_HINTS) {
      if (re.test(coverPageText)) return { type, confident: true, source: "page-text" }
    }
  }
  return { type: null, confident: false, source: "none" }
}

// ─── Coversheet boundary detection ──────────────────────────────────────────
//
// Cover detection is UNIFIED on `findStripPlan` / COVER_VOCAB (pdf-strip.ts) —
// the SAME boundary-by-vocabulary detector the Library strip uses. The old
// two-template fingerprint (`detectCoverSplit`) was retired (2026-06-08) so
// the review-screen split reflects exactly what on-demand stripping will
// remove. `analyzePdf` no longer computes a cover split itself; the analyze
// route computes it via `analyzeCoverSplit(buffer)` (pdf-strip.ts) — which has
// the buffer needed to read AcroForm-widget and /Stamp signals that pure text
// can't see — and passes the result in. This module stays pure (no I/O).
//
// NOTE: this changes ONLY the review NUMBER (human-confirmed in the review UI).
// Where/when stripping executes is unchanged (commit-time vs on-demand is a
// separate, deferred decision — out of scope here).

export interface CoverSplitResult {
  /** Number of leading pages that ARE coversheets. coverSplit=2 means pages
   *  1+2 are cover; page 3 is the first content page. 0 = no leading cover
   *  run detected. */
  coverSplit: number
  /** Flips when detection couldn't find a leading cover run (coverSplit=0),
   *  so the review row warns the user to set the split manually. */
  uncertain: boolean
  /** Human-readable reason, surfaced in the review table tooltip. */
  reason: string
}

// ─── Top-level analysis ─────────────────────────────────────────────────────

export interface BulkImportAnalysis {
  pageCount: number
  filename: string
  /** Final suggested section. Generic CSI extractor (form widgets + cover
   *  page text) wins; filename is only a fallback when extraction returned
   *  nothing or flagged disagreement. */
  suggestedSection: string | null
  suggestedSectionDivision: string | null
  /** Section the generic extractor surfaced (regardless of tier). */
  formSection: string | null
  filenameSection: FilenameSectionGuess
  /** Deprecated. The legacy page-text label scrape was replaced by the
   *  generic extractor; this field stays for callers that read it, but is
   *  always null going forward. */
  pageSection: string | null
  /** Coarse source of the value we actually surfaced. */
  sectionSource: "form" | "page" | "filename" | "none"
  /** Tier that produced the surfaced section (null when filename or none). */
  sectionTier: SectionCandidateTier | null
  sectionFlag: boolean
  /** Distinct labeled sections found in the coversheet (form + page) that
   *  disagree with each other. Non-empty → primary is null, user must pick. */
  sectionDisagreement: string[]
  /** Final suggested type, plus the raw signal source. */
  suggestedType: SubmittalType | null
  typeGuess: SubmittalTypeGuess
  typeFlag: boolean
  /** Coversheet boundary analysis. */
  cover: CoverSplitResult
  /** Other coversheet-form values recovered for review-table pre-fill. */
  coverFields: CoversheetFields
  /** YYYY-MM-DD pre-fill for the approval-date input. Sourced ONLY from
   *  the PDF /Stamp annotation's /CreationDate (the architect's signing
   *  action). NEVER falls back to the GC's submission date (Text4) — when
   *  no stamp is found, this is null and the row flags for manual entry.
   *  See approvalStamp below for the metadata. */
  suggestedApprovalDate: string | null
  /** YYYY-MM-DD pre-fill for the submission-date input — the GC's
   *  Text4 "Date Submitted" value, kept as a separate field so it
   *  never gets confused with the approval date. */
  suggestedSubmittedDate: string | null
  /** Full architect-stamp metadata when a /Stamp annotation was found
   *  (date / author / page / stamp name). Null when no stamp on the
   *  scanned front-matter pages. Stage 2b's cover-strip uses
   *  `approvalStamp.page` as the strip-through anchor. */
  approvalStamp: ApprovalStampInfo | null
  /** Pre-fill for the submittal-no input. */
  suggestedSubmittalNo: string | null
  /** Per-field confidence — "label" = real labeled field hit OR known
   *  template field position; "positional" = value-shape guess on an
   *  unknown template; "none" = nothing found. The review row flags
   *  "positional" fields as unconfirmed so the user knows to verify. */
  coverFieldsConfidence: CoversheetFieldsConfidence
  /** Which coversheet form template the extractor matched. "waters" / "bam-thp"
   *  use known field maps; "unknown" relies on value-shape heuristics. */
  coverTemplate: CoversheetTemplate
  /** Additional sections found inside the section field — e.g. Waters'
   *  "Section 09-67-23 & 09-65-19". Primary goes in `suggestedSection`,
   *  the rest live here so the row flags that the user may want to split. */
  additionalSections: string[]
  /** Aggregate "this row needs attention" — any of the individual flags. */
  needsAttention: boolean
  /** Human-readable summary for the review-table tooltip / warning. */
  notes: string[]
}

const EMPTY_COVER_FIELDS: CoversheetFields = {
  specSectionNo: null, specSectionTitle: null, submittalNo: null,
  dateSubmitted: null, projectName: null, submitter: null,
}
const EMPTY_COVER_FIELDS_CONFIDENCE: CoversheetFieldsConfidence = {
  specSectionNo: "none", specSectionTitle: "none", submittalNo: "none",
  dateSubmitted: "none", projectName: "none", submitter: "none",
}

// ─── Template-agnostic CSI section extractor ────────────────────────────────
//
// Section detection runs ONCE, regardless of which subcontractor's coversheet
// the file came from. CSI MasterFormat is an industry standard — every
// section number is "DD UU SU" / "DD-UU-SU" / "DDUUSU" with a real
// MasterFormat division as the first two digits.
//
// We scan form widget values AND coversheet-page text (pages BEFORE
// cover.coverSplit only, to avoid false positives from product-page
// datasheets that mention an unrelated section). Candidates are ranked by
// tier, validated against `VALID_DIVISIONS`, and surfaced primary + extras.
//
// Tier ranking (best → worst):
//   labeled-form     — "...Section NN-NN-NN..." inside a form widget value
//   labeled-page     — "...Section NN-NN-NN..." in coversheet page text
//   bare-form        — bare "NN NN NN" / "NN-NN-NN" with valid division
//                       inside a form widget value
//   bare-page        — same, in coversheet page text
//   compact-form     — bare "NNNNNN" with valid division in a form widget
//   compact-page     — same, in coversheet page text
//
// When multiple LABELED hits exist that disagree on section, we DO NOT
// silently pick one — we set `labeledDisagreement` so the row flags and
// the user must choose. Disagreement among bare/compact tiers is not
// surfaced (those hits are too weak to second-guess).
//
// IMPORTANT — never default a section. If extraction fails, primary stays
// null, the row flags, and Stage 2 commit MUST be blocked until the user
// fills it in (see commit-gate comment below `analyzePdf`).

export type SectionCandidateTier =
  | "labeled-form"
  | "labeled-page"
  | "bare-form"
  | "bare-page"
  | "compact-form"
  | "compact-page"

export interface ExtractedSection {
  primary: string | null
  /** Other sections found in the SAME labeled value (e.g. Waters Sub 158:
   *  "Section 09-67-23 & 09-65-19"). Stage 2 will flag the row so the user
   *  can split into separate submittals. */
  siblings: string[]
  /** Which tier the primary was sourced from. Null when nothing matched. */
  tier: SectionCandidateTier | null
  /** Set when 2+ distinct labeled-tier candidates were found. When non-empty,
   *  `primary` is null — never silently pick one. */
  labeledDisagreement: string[]
}

const EMPTY_EXTRACTED_SECTION: ExtractedSection = {
  primary: null, siblings: [], tier: null, labeledDisagreement: [],
}

// Anchored on the "Section" keyword (or its full-form variants). The keyword
// is required, so this won't fire on phone numbers, project IDs, or random
// 6-digit runs. Lookbehind on the keyword `\b` prevents matching within
// "Subsection" or other word substrings.
const LABELED_SECTION_RE =
  /\b(?:Spec(?:ification)?\s+Section|CSI\s+Section|Section|Spec\s+Sec\.?)\s*(?:No\.?|#|Number)?\s*[:\-]?\s*(\d{2})[-\s.](\d{2})[-\s.](\d{2})(?!\d)/gi

// Bare CSI shape — `NN<sep>NN<sep>NN` where sep is space, dash, or dot.
// The negative lookbehind rejects digits AND letters/underscores so we
// don't pick up the tail of a longer number ("0063510") or run into a
// version string. Negative lookahead rejects a 4th digit (so "203-334-6888"
// — `\d{3}-\d{3}-\d{4}` — never matches because the shape requires 2-2-2).
const BARE_SECTION_RE =
  /(?<![\w\d])(\d{2})[-\s.](\d{2})[-\s.](\d{2})(?!\d)/g

// Compact 6-digit, no separators. Lowest-confidence tier — only used when
// nothing else hit. Word-bounded so contiguous longer runs don't leak in.
const COMPACT_SECTION_RE = /(?<!\d)(\d{6})(?!\d)/g

function isValidDivision(d: string): boolean {
  return VALID_DIVISIONS.has(d)
}

/** Pull all valid labeled sections out of a single string. Returns the
 *  primary (first labeled hit) + siblings (additional dashed/spaced CSI
 *  matches found AFTER the labeled hit, within the same string — handles
 *  multi-section coversheets like "Section 09-67-23 & 09-65-19"). */
function findLabeledSectionsInValue(text: string): { primary: string; siblings: string[] }[] {
  if (!text) return []
  const out: { primary: string; siblings: string[] }[] = []
  for (const m of text.matchAll(LABELED_SECTION_RE)) {
    if (!isValidDivision(m[1])) continue
    const primary = `${m[1]} ${m[2]} ${m[3]}`
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200)
    const siblings: string[] = []
    for (const sm of tail.matchAll(BARE_SECTION_RE)) {
      if (isValidDivision(sm[1])) {
        const sib = `${sm[1]} ${sm[2]} ${sm[3]}`
        if (sib !== primary && !siblings.includes(sib)) siblings.push(sib)
      }
      if (siblings.length >= 4) break
    }
    out.push({ primary, siblings })
  }
  return out
}

function findBareSectionsInValue(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(BARE_SECTION_RE)) {
    if (isValidDivision(m[1])) {
      const candidate = `${m[1]} ${m[2]} ${m[3]}`
      if (!out.includes(candidate)) out.push(candidate)
    }
  }
  return out
}

function findCompactSectionsInValue(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(COMPACT_SECTION_RE)) {
    const six = m[1]
    if (isValidDivision(six.slice(0, 2))) {
      const candidate = `${six.slice(0, 2)} ${six.slice(2, 4)} ${six.slice(4, 6)}`
      if (!out.includes(candidate)) out.push(candidate)
    }
  }
  return out
}

/**
 * Generic CSI section extractor — runs against form widget values plus
 * coversheet-page text, ranks candidates by tier, never defaults to a
 * section. Caller is responsible for surfacing `primary == null` to the
 * user as a required-input flag and blocking commit at Stage 2.
 *
 * `coverPageTexts` should be `pageTexts.slice(0, cover.coverSplit)` — i.e.
 * only the pages classified as coversheet. Scanning further would risk
 * pulling a CSI reference out of a product datasheet inside the submittal.
 */
export function extractCsiSectionFromCoversheet(
  rawForm: RawFormFields,
  coverPageTexts: string[],
): ExtractedSection {
  // Tier 1 — labeled hits in form widget values.
  const labeledForm: { primary: string; siblings: string[] }[] = []
  for (const v of Object.values(rawForm)) {
    for (const hit of findLabeledSectionsInValue(v)) labeledForm.push(hit)
  }
  // Tier 2 — labeled hits in coversheet page text.
  const labeledPage: { primary: string; siblings: string[] }[] = []
  for (const pg of coverPageTexts) {
    for (const hit of findLabeledSectionsInValue(pg)) labeledPage.push(hit)
  }

  if (labeledForm.length > 0 || labeledPage.length > 0) {
    const all = [...labeledForm, ...labeledPage]
    const distinctPrimaries = [...new Set(all.map(x => x.primary))]
    if (distinctPrimaries.length === 1) {
      // Unanimous labeled signal. Use the first hit's siblings (multi-section
      // case lives inside one value).
      return {
        primary: distinctPrimaries[0],
        siblings: all[0].siblings,
        tier: labeledForm.length > 0 ? "labeled-form" : "labeled-page",
        labeledDisagreement: [],
      }
    }
    // 2+ distinct labeled hits — DO NOT silently pick one. Force a user pick.
    return {
      primary: null,
      siblings: [],
      tier: labeledForm.length > 0 ? "labeled-form" : "labeled-page",
      labeledDisagreement: distinctPrimaries,
    }
  }

  // Tier 3 — bare CSI shape in form widget values.
  const bareForm: string[] = []
  for (const v of Object.values(rawForm)) bareForm.push(...findBareSectionsInValue(v))
  if (bareForm.length > 0) {
    return { primary: bareForm[0], siblings: [], tier: "bare-form", labeledDisagreement: [] }
  }

  // Tier 4 — bare CSI in coversheet page text.
  const barePage: string[] = []
  for (const pg of coverPageTexts) barePage.push(...findBareSectionsInValue(pg))
  if (barePage.length > 0) {
    return { primary: barePage[0], siblings: [], tier: "bare-page", labeledDisagreement: [] }
  }

  // Tier 5 — compact 6-digit in form. False-positive prone (item numbers,
  // partial dates). Lowest confidence; only used as a last resort.
  const compactForm: string[] = []
  for (const v of Object.values(rawForm)) compactForm.push(...findCompactSectionsInValue(v))
  if (compactForm.length > 0) {
    return { primary: compactForm[0], siblings: [], tier: "compact-form", labeledDisagreement: [] }
  }

  // Tier 6 — compact 6-digit in page text.
  const compactPage: string[] = []
  for (const pg of coverPageTexts) compactPage.push(...findCompactSectionsInValue(pg))
  if (compactPage.length > 0) {
    return { primary: compactPage[0], siblings: [], tier: "compact-page", labeledDisagreement: [] }
  }

  return EMPTY_EXTRACTED_SECTION
}

/**
 * Run all detectors over a single PDF and return the suggestions. Stage 1
 * emits this object per row; Stage 2 will accept the (possibly user-edited)
 * version of these fields and perform the commit.
 *
 * Section detection is now **template-agnostic**: a single CSI-shape
 * extractor (`extractCsiSectionFromCoversheet`) scans form widget values
 * plus coversheet-page text and ranks candidates by tier — no per-template
 * field map drives the section decision. The recovery layer
 * (`recoverCoversheetFields`) is consulted only for **nice-to-have**
 * fields (submitter, title, submittal#, date, project), which can vary
 * by coversheet author without breaking section.
 *
 * STAGE 2 — COMMIT-GATE CONTRACT (lock this in when Stage 2 ships):
 *   - Per-row commit MUST be blocked when `suggestedSection` is null OR
 *     `sectionFlag` is still true after the user edits the row. Never
 *     guess, never default — section drives log placement.
 *   - The bulk-commit (footer) button MUST be disabled when ANY row has
 *     an empty section or unresolved `labeledDisagreement`.
 *   - When `additionalSections.length > 0` (multi-section row), Stage 2
 *     should offer to fan out into one submittal per section OR commit
 *     against the primary with the user's explicit acknowledgement.
 *
 * STAGE 2 ORDERING (note for the commit/strip implementation): all
 * coversheet reads — section, submittal#, date, etc. — MUST run BEFORE
 * any coversheet stripping. Once the cover pages are removed, the AcroForm
 * widgets and the labeled text both go with them. Never strip then read.
 *
 * STAGE 2 — COVER-SPLIT FIXES (observed gaps as of 2026-06-03):
 *   (a) `looksLikeSubmitterCoversheet` does NOT match the Waters template.
 *       The Waters submitter cover has no "Submittal No." / "Date Submitted"
 *       labels in the page text — the labels are inside form widgets, not
 *       in the content stream. The fingerprint needs additional Waters
 *       cues OR a fallback: if the file has a recognized fillable form on
 *       the first page (AcroForm widgets we can enumerate), treat that
 *       page as a coversheet regardless of page-text label matches. Today
 *       Waters batches default to coverSplit=0/1 even on long submittals.
 *
 *   (b) The strip target is broader than "the coversheet page". The
 *       Library copy must have ALL front routing/approval pages stripped
 *       — that includes (1) the submitter coversheet AND (2) the
 *       architect approval-STAMP page(s). The architect stamp typically
 *       sits on page 1 (BAM/THP) or before the first product datasheet,
 *       and identifies itself by stamp vocabulary ("Approved (A)",
 *       "Exceptions Noted", "Revise and Resubmit"), the architect's
 *       signature box, and the project info banner. `detectCoverSplit`
 *       already counts a leading architect-review page as coversheet via
 *       `looksLikeArchitectReview`; Stage 2's strip-on-commit must
 *       consume the full `cover.coverSplit` count and not stop at "page 1"
 *       — the routing/approval pages can stack 2–3 deep depending on the
 *       submission flow.
 *
 *   Both (a) and (b) preserve the read-before-strip invariant above:
 *   section + nice-to-haves come out of the form widgets and page text
 *   FIRST, then the coversheet+stamp pages are removed for the Library
 *   copy. The Submittal Log entry retains a reference to the original
 *   (unstripped) PDF for downloads / audit; only the Library-facing
 *   asset is the stripped version.
 *
 *   (c) ACTUAL HEURISTIC (lands with the approval-date fix): the
 *   architect's stamp is a PDF /Stamp annotation. The analyze step
 *   already locates it (page index in `analysis.approvalStamp.page`).
 *   Stage 2b's strip endpoint = LAST page through and including the
 *   page that carries the /Stamp annotation, PLUS any immediately-
 *   following pages with < 10 chars of extractable text (the
 *   "intentionally-blank" routing separator page Waters includes).
 *   This replaces the broken page-text fingerprint default. Anchor
 *   logic shared with extractApprovalStampDate so a single scan
 *   covers both date extraction AND strip-end detection.
 *
 *   DISPOSITION extraction (Approved vs Approved as Noted vs Revise and
 *   Resubmit) is DEFERRED — it lives in the stamp's nested /BBA form
 *   XObjects (checkbox states drawn as vector overlays). Recoverable
 *   via render+OCR or by mapping the present /BBA child names against a
 *   stamp-template dictionary, but not blocking the date fix. The
 *   approval DATE alone (from /CreationDate) is sufficient for the
 *   official-record column; disposition is a follow-up item.
 *
 * STAGE 2 — STAGING AUTO-PURGE (observed gap as of 2026-06-03):
 *   `bulk-import-staging/` accumulates orphans because Stage 1 has no
 *   commit step — every analyzed PDF lands there and stays. By the end
 *   of the user's 2026-06-03 batch testing there were 84 staged objects
 *   totaling 427.7 MB (~43% of the project's Supabase 1 GB free-tier
 *   quota) with zero references from any `submittals` row. A one-off
 *   manual cleanup recovered the space.
 *
 *   Stage 2 must close this leak. Options for the auto-purge hook:
 *     - On successful per-row commit: delete that row's staging object.
 *       Bytes promoted to the Library copy live at a different storage
 *       path under `submittals/uploads/` (the canonical home), so the
 *       staging object is pure scratch once commit succeeds.
 *     - On session end / modal close with unpromoted rows: prompt
 *       "Discard N unsaved staged files?" — accept = delete, defer =
 *       leave (relying on the TTL sweep below).
 *     - TTL sweep — a scheduled cleanup (cron-style, or a check on
 *       the next bulk-import session opening) that removes any staging
 *       object older than e.g. 24h AND not referenced by any submittals
 *       row. Cross-check is critical: cross-reference every candidate
 *       against `submittals.storage_path` before deleting. Today's
 *       audit showed 0 staging-path references in any submittals row
 *       — that's the expected invariant; the sweep must enforce it.
 *
 *   See `scripts/staging-cleanup-candidates.json` and
 *   `scripts/bulk-import-find-filename-less.mjs` for the audit pattern
 *   used in the 2026-06-03 manual cleanup.
 *
 * `pageTexts[i]` = text for page i+1. `rawForm` is the AcroForm widget
 * map (empty object when the PDF has no form). `recovery` carries the
 * nice-to-have fields (template-aware) + template label.
 */
export function analyzePdf(
  filename: string,
  pageTexts: string[],
  rawForm: RawFormFields = {},
  recovery: {
    fields: CoversheetFields
    confidence: CoversheetFieldsConfidence
    template: CoversheetTemplate
  } = {
    fields: EMPTY_COVER_FIELDS,
    confidence: EMPTY_COVER_FIELDS_CONFIDENCE,
    template: "unknown",
  },
  approvalStamp: ApprovalStampInfo | null = null,
  // Cover split is now computed by the analyze route via analyzeCoverSplit
  // (pdf-strip.ts / findStripPlan) — the SAME detector the Library strip uses.
  // analyzePdf stays pure: it receives the result rather than re-detecting.
  cover: CoverSplitResult = { coverSplit: 0, uncertain: true, reason: "No cover split computed." },
): BulkImportAnalysis {
  const filenameSection = parseSectionFromFilename(filename)
  const page1Text = pageTexts[0] ?? ""
  const page2Text = pageTexts[1] ?? ""

  // The section extractor needs to know which pages are coversheet so it
  // doesn't grab CSI references out of product datasheets buried inside the
  // submittal. Use the passed-in cover split (min 2 pages so a 0/1 detection
  // still scans the typical 2-page front matter for the section).
  const coverPageTexts = pageTexts.slice(0, Math.max(cover.coverSplit, 2))

  // Template-agnostic generic section extraction. Wins over filename
  // (filename is a sanity-check, not a source of truth — it can be
  // anything the GC named the PDF).
  const csi = extractCsiSectionFromCoversheet(rawForm, coverPageTexts)
  const formSection = csi.primary

  let suggestedSection: string | null = null
  let sectionSource: "form" | "page" | "filename" | "none" = "none"
  if (csi.primary && (csi.tier === "labeled-form" || csi.tier === "bare-form" || csi.tier === "compact-form")) {
    suggestedSection = csi.primary
    sectionSource = "form"
  } else if (csi.primary && (csi.tier === "labeled-page" || csi.tier === "bare-page" || csi.tier === "compact-page")) {
    suggestedSection = csi.primary
    sectionSource = "page"
  } else if (filenameSection.section) {
    suggestedSection = filenameSection.section
    sectionSource = "filename"
  }

  const sectionFlag = (() => {
    if (!suggestedSection) return true
    // Multiple labeled candidates disagreed — user must pick.
    if (csi.labeledDisagreement.length > 0) return true
    // Form/page vs filename mismatch — surface for cross-check (extractor
    // value still wins, but the user should know).
    if ((sectionSource === "form" || sectionSource === "page") &&
        filenameSection.section &&
        csi.primary !== filenameSection.section) return true
    // A loose-6-digit-only filename hit with no extractor corroboration is weak.
    if (sectionSource === "filename" && filenameSection.source === "loose-6digit") return true
    // Compact-tier hit (no labels, no separators) is brittle — flag for confirm.
    if (sectionSource === "form" && csi.tier === "compact-form") return true
    if (sectionSource === "page" && csi.tier === "compact-page") return true
    return false
  })()

  // Type detection reads BOTH the text layer AND the AcroForm value layer.
  // Section detection already trusts form values (Gilbane's section sits in a
  // generically-/misleadingly-named widget, e.g. "Submittal No (1)" = "06 16
  // 00"); type must too — Gilbane puts the type in a widget value (e.g.
  // "Text14" = "Product Data" / "Design Mix" / "Shop Drawing") that never
  // reaches the page-text layer. Template-agnostic + value-based (no
  // field-name / label / position dependence):
  //   (a) EXACT-VALUE shortcut — if any form value is exactly a known type,
  //       take it (high confidence). The labeled-dropdown case.
  //   (b) else run the hint matcher over filename + page text + form values.
  const formValues = Object.values(rawForm).filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  )
  let exactType: SubmittalType | null = null
  for (const v of formValues) {
    const hit = SUBMITTAL_TYPES.find(t => t.toLowerCase() === v.trim().toLowerCase())
    if (hit) { exactType = hit; break }
  }
  const typeGuess: SubmittalTypeGuess = exactType
    ? { type: exactType, confident: true, source: "form-value" }
    : detectSubmittalType(filename, [
        page1Text, page2Text,
        recovery.fields.specSectionTitle ?? "",  // recovered title carries strong type hints
        formValues.join("\n"),                    // ← form-value layer (Gilbane et al.)
      ].join("\n"))
  const suggestedType = typeGuess.type
  const typeFlag = !typeGuess.confident

  // Pre-fill review-row nice-to-haves from recovery + stamp annotation.
  // Two separate dates:
  //   suggestedApprovalDate — architect's stamp /CreationDate (THE approval).
  //     NEVER falls back to Text4. If no stamp present, this is null and
  //     the row flags for manual entry.
  //   suggestedSubmittedDate — Text4 ("Date Submitted" on the Waters
  //     coversheet). This IS the GC's submission date, surfaced
  //     separately so it never gets confused with approval.
  const suggestedApprovalDate  = approvalStamp?.date ?? null
  const suggestedSubmittedDate = normalizeApprovalDate(recovery.fields.dateSubmitted)
  const suggestedSubmittalNo   = recovery.fields.submittalNo?.trim() || null

  const additionalSections = csi.siblings

  const notes: string[] = []
  if (sectionFlag) {
    if (!suggestedSection) {
      if (csi.labeledDisagreement.length > 0) {
        notes.push(
          `Coversheet text labeled multiple distinct sections: ${csi.labeledDisagreement.join(", ")}. ` +
          `Pick one before commit — we won't guess.`,
        )
      } else {
        notes.push("Couldn't read a spec section from the coversheet form, page text, or filename. Enter it manually before commit.")
      }
    } else if ((sectionSource === "form" || sectionSource === "page") &&
               filenameSection.section &&
               csi.primary !== filenameSection.section) {
      notes.push(`Coversheet says ${csi.primary}; filename suggests ${filenameSection.section}. Defaulted to the coversheet value.`)
    } else if (sectionSource === "filename" && filenameSection.source === "loose-6digit") {
      notes.push(`Section was guessed from a loose 6-digit run in the filename — no coversheet form value or labeled page text. Confirm before commit.`)
    } else if (sectionSource === "form" && csi.tier === "compact-form") {
      notes.push(`Section came from a compact 6-digit run in a form field, with no "Section" label nearby — confirm before commit.`)
    } else if (sectionSource === "page" && csi.tier === "compact-page") {
      notes.push(`Section came from a compact 6-digit run in the coversheet page text, with no "Section" label nearby — confirm before commit.`)
    }
  }
  if (typeFlag) notes.push("Couldn't infer the submittal type — pick one from the list.")
  if (cover.uncertain) notes.push(cover.reason)
  if (recovery.fields.dateSubmitted && !suggestedSubmittedDate) {
    notes.push(`GC submission date "${recovery.fields.dateSubmitted}" wasn't in a format we could parse — confirm in the field.`)
  }
  // No stamp annotation found = no approval date recoverable from the PDF.
  // Per the design: NEVER fall back to Text4 (submission date). Flag and
  // let the user enter the architect's approval date manually.
  if (!suggestedApprovalDate) {
    notes.push("No architect stamp found on the cover pages — enter the approval date manually.")
  }

  // Surface a "positional guess" note when the submittal # came from
  // value-shape / widget-position inference (THP's generic Text1..Text10
  // names hit this path on every file). User sees a subtle styling on
  // the input AND a one-line nudge.
  if (
    suggestedSubmittalNo &&
    recovery.confidence.submittalNo === "positional"
  ) notes.push(`Submittal # was guessed positionally — verify.`)

  const reportedApprovalDateConfidence: FieldConfidence = suggestedApprovalDate
    ? "label"  // stamp date is always authoritative — never positional
    : "none"
  const reportedSubmittalNoConfidence: FieldConfidence = suggestedSubmittalNo
    ? recovery.confidence.submittalNo
    : "none"

  // Multi-section case ("Section 09-67-23 & 09-65-19") — the generic CSI
  // extractor surfaces extras as siblings. We pre-fill only the primary;
  // Stage 2 will offer to split per the commit-gate contract above.
  if (additionalSections.length > 0) {
    notes.push(
      `Coversheet lists ${1 + additionalSections.length} sections (${[suggestedSection, ...additionalSections].filter(Boolean).join(", ")}). Pre-filled the first; split into separate rows if both apply.`,
    )
  }

  return {
    pageCount: pageTexts.length,
    filename,
    suggestedSection,
    suggestedSectionDivision: suggestedSection ? divisionNameFor(suggestedSection) : null,
    formSection,
    filenameSection,
    // pageSection retained as a (now-thin) compatibility shim — the legacy
    // page-text label scrape is dead, the generic extractor subsumes it.
    pageSection: null,
    sectionSource,
    sectionTier: csi.tier,
    sectionFlag,
    sectionDisagreement: csi.labeledDisagreement,
    suggestedType,
    typeGuess,
    typeFlag,
    cover,
    coverFields: recovery.fields,
    suggestedApprovalDate,
    suggestedSubmittedDate,
    approvalStamp,
    suggestedSubmittalNo,
    coverFieldsConfidence: {
      ...recovery.confidence,
      dateSubmitted: reportedApprovalDateConfidence,
      submittalNo: reportedSubmittalNoConfidence,
    },
    coverTemplate: recovery.template,
    additionalSections,
    needsAttention: sectionFlag || typeFlag || cover.uncertain || additionalSections.length > 0,
    notes,
  }
}
