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
import type { CoversheetFieldsConfidence, FieldConfidence } from "./bulk-import-form"

// ─── Fixed vocabulary ───────────────────────────────────────────────────────

/** Live submittal-type vocabulary. Matches the values present in production
 *  (`submittals.submittal_type` text column, app-enforced — no DB enum).
 *  This is the importer's guardrail against drift. */
export const SUBMITTAL_TYPES = [
  "Product Data",
  "Shop Drawing",
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
  projectName:      string | null
}

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
  source: "filename" | "page-text" | "none"
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
// Two stacked coversheets per the THP/BAM template (sample of 11 real
// submittals reviewed 2026-06-01):
//
//   Page 1 — Architect review sheet (BAM)
//     Header: "Submittal / Architecture / Branding+Digital / Interior Design /
//             Strategic Action" (or just "Submittal" + architect identifier)
//     Stamp: "Approved (A)" / "Exceptions Noted (EN)" /
//            "Not Approved (NA)" / "Revise and Resubmit"
//     Project: "BAM Project Number" (or generic "Project No.")
//
//   Page 2 — Submitter coversheet
//     Labeled fields: "Project Name", "Project Number", "Spec Section Title",
//                     "Spec Section No.", "Submittal No.", "Date Submitted"
//
// The leading run of pages matching one of these templates IS the coversheet.
// Product content begins at the first page that matches NEITHER.
//
// Fallback for scanned cover pages (no text layer): a leading page with
// very low extractable text is treated as a probable coversheet AND the row
// is flagged as uncertain. Never guess silently.

/** Char count below which a page is considered "low text" — likely scanned.
 *  Kept tight (30) so that real but sparse product pages aren't mistaken for
 *  blank scanned coversheets. */
const LOW_TEXT_THRESHOLD = 30

function pageCharCount(t: string): number {
  return t.replace(/\s+/g, "").length
}

/** Looks like an architect review sheet (page-1 template)?
 *  Two of: review stamp vocabulary, architect/project header, project-no label. */
function looksLikeArchitectReview(text: string): boolean {
  if (!text) return false
  let hits = 0
  if (/\b(?:Approved|Exceptions\s+Noted|Not\s+Approved|Revise\s+and\s+Resubmit|Reviewed)\b/i.test(text)) hits++
  if (/\b(?:Architect(?:ure)?|BAM|Branding|Interior\s+Design|Strategic\s+Action)\b/i.test(text)) hits++
  if (/\b(?:Project\s*(?:No\.?|Number)|Submittal\s+Review)\b/i.test(text)) hits++
  return hits >= 2
}

/** Looks like a submitter coversheet (page-2 template)?
 *  Three of the labeled fields present. */
function looksLikeSubmitterCoversheet(text: string): boolean {
  if (!text) return false
  let hits = 0
  if (/Spec(?:ification)?\s+Section\s*(?:No\.?|Title|#|Number)/i.test(text)) hits++
  if (/Submittal\s+(?:No\.?|Number|#)/i.test(text)) hits++
  if (/Date\s+Submitted/i.test(text)) hits++
  if (/Project\s+(?:Name|Number|No\.?)/i.test(text)) hits++
  if (/Submitted\s+(?:By|To)/i.test(text)) hits++
  return hits >= 3
}

export type CoverPageKind =
  | "architect-review"
  | "submitter-coversheet"
  | "low-text-leading"
  | "product"

export interface CoverSplitResult {
  /** Number of leading pages that ARE coversheets. coverSplit=2 means pages
   *  1+2 are cover; page 3 is the first content page. */
  coverSplit: number
  /** Per-page classification, length = pageCount. */
  perPage: CoverPageKind[]
  /** Loud-flag flips when detection is unsure — at least one leading page is
   *  low-text, or no template matched and we fell back to a generic guess. */
  uncertain: boolean
  /** Human-readable reason, surfaced in the review table tooltip. */
  reason: string
}

/**
 * Walks pages from page 1 forward. While the leading page matches an
 * architect or submitter template, count it as cover. Stop at the first
 * "product" page (matches neither). Low-text leading pages are counted as
 * cover BUT flip `uncertain` so the row warns the user.
 *
 * `pageTexts` is 0-indexed; the returned coverSplit and perPage use page
 * positions 1..N implicitly (perPage[i] describes page i+1).
 */
export function detectCoverSplit(pageTexts: string[]): CoverSplitResult {
  const perPage: CoverPageKind[] = []
  let coverSplit = 0
  let uncertain = false
  let lowTextLeading = 0
  let noTemplateMatchYet = true
  // Once a template page has matched, low-text pages are NOT treated as
  // leading scanned coversheets anymore — they're sparse product pages
  // (drawings, mostly-image specs, etc.). The low-text fallback is only for
  // the very first pages, before any template has confirmed where the
  // coversheet actually starts.
  let templateMatched = false

  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i] ?? ""
    const charCount = pageCharCount(text)

    // Already past the coversheet — anything else is content.
    if (coverSplit !== i) {
      perPage.push("product")
      continue
    }

    if (charCount < LOW_TEXT_THRESHOLD && !templateMatched) {
      // Leading low-text page BEFORE any template hit. Probable scanned
      // coversheet; treat as cover but flag.
      perPage.push("low-text-leading")
      coverSplit++
      uncertain = true
      lowTextLeading++
      continue
    }

    if (looksLikeArchitectReview(text)) {
      perPage.push("architect-review")
      coverSplit++
      templateMatched = true
      noTemplateMatchYet = false
      continue
    }
    if (looksLikeSubmitterCoversheet(text)) {
      perPage.push("submitter-coversheet")
      coverSplit++
      templateMatched = true
      noTemplateMatchYet = false
      continue
    }

    // First page that matches NEITHER template — product content starts here.
    perPage.push("product")
  }

  // Edge cases that should flip uncertainty:
  //  - No template matched on ANY leading page. Either it's an unrecognized
  //    architect template, or every cover page was scanned. Coversplit is
  //    whatever the low-text fallback produced (possibly 0); user must confirm.
  if (noTemplateMatchYet) uncertain = true
  //  - Found zero leading pages of any kind — i.e. coverSplit=0. Almost
  //    certainly wrong for a signed submittal; flag loudly.
  if (coverSplit === 0) uncertain = true
  //  - Found ALL pages classified as cover — there's no content left.
  //    Something is off with the fingerprint or the file is cover-only.
  if (coverSplit === pageTexts.length && pageTexts.length > 0) uncertain = true

  let reason: string
  if (coverSplit === 0) {
    reason = "Couldn't locate a coversheet on page 1 — set the split manually."
  } else if (coverSplit === pageTexts.length) {
    reason = "Every page looks like coversheet content — confirm the split."
  } else if (lowTextLeading > 0) {
    reason = `${lowTextLeading} leading page${lowTextLeading === 1 ? "" : "s"} had little/no extractable text (probable scanned coversheet). Confirm the split.`
  } else if (noTemplateMatchYet) {
    reason = "Coversheet template wasn't recognized — confirm the split."
  } else {
    reason = `Coversheet ends after page ${coverSplit}; product content begins page ${coverSplit + 1}.`
  }

  return { coverSplit, perPage, uncertain, reason }
}

// ─── Top-level analysis ─────────────────────────────────────────────────────

export interface BulkImportAnalysis {
  pageCount: number
  filename: string
  /** Final suggested section. Form field wins when present (authoritative),
   *  then page-text label, then filename. */
  suggestedSection: string | null
  suggestedSectionDivision: string | null
  /** Section parsed from the coversheet's AcroForm "Spec Section No." widget. */
  formSection: string | null
  filenameSection: FilenameSectionGuess
  pageSection: string | null
  /** Source of the value we actually surfaced. */
  sectionSource: "form" | "page" | "filename" | "none"
  sectionFlag: boolean
  /** Final suggested type, plus the raw signal source. */
  suggestedType: SubmittalType | null
  typeGuess: SubmittalTypeGuess
  typeFlag: boolean
  /** Coversheet boundary analysis. */
  cover: CoverSplitResult
  /** Other coversheet-form values recovered for review-table pre-fill. */
  coverFields: CoversheetFields
  /** Normalized YYYY-MM-DD pre-fill for the approval-date input. */
  suggestedApprovalDate: string | null
  /** Pre-fill for the submittal-no input. */
  suggestedSubmittalNo: string | null
  /** Per-field confidence — "label" = real labeled field hit;
   *  "positional" = value-shape / widget-position guess; "none" = nothing
   *  found. The review row flags "positional" fields as unconfirmed so the
   *  user knows to verify before commit. */
  coverFieldsConfidence: CoversheetFieldsConfidence
  /** Aggregate "this row needs attention" — any of the individual flags. */
  needsAttention: boolean
  /** Human-readable summary for the review-table tooltip / warning. */
  notes: string[]
}

const EMPTY_COVER_FIELDS: CoversheetFields = {
  specSectionNo: null, specSectionTitle: null, submittalNo: null,
  dateSubmitted: null, projectName: null,
}
const EMPTY_COVER_FIELDS_CONFIDENCE: CoversheetFieldsConfidence = {
  specSectionNo: "none", specSectionTitle: "none", submittalNo: "none",
  dateSubmitted: "none", projectName: "none",
}

/**
 * Run all three detectors over a single PDF and return the suggestions.
 * Stage 1 emits this object per row; Stage 2 will accept the (possibly
 * user-edited) version of these fields and perform the commit.
 *
 * `pageTexts[i]` = text for page i+1. The caller (server route) is
 * responsible for getting the text out of the PDF.
 *
 * `coverFields` is the result of pdf-lib AcroForm widget enumeration —
 * the authoritative source for THP submitter coversheets. When present,
 * the form's Spec Section No. wins over page-text scraping and filename
 * parsing. Pass an empty fields object when the PDF has no AcroForm or
 * extraction failed; section detection then falls back to the older
 * page-text + filename path.
 *
 * STAGE 2 ORDERING (note for the commit/strip implementation): all
 * coversheet reads — section, submittal #, date, etc. — MUST run before
 * any coversheet stripping. Once the cover pages are removed, the AcroForm
 * widgets and the labeled text both go with them. Never strip then read.
 */
export function analyzePdf(
  filename: string,
  pageTexts: string[],
  coverFields: CoversheetFields = EMPTY_COVER_FIELDS,
  coverFieldsConfidence: CoversheetFieldsConfidence = EMPTY_COVER_FIELDS_CONFIDENCE,
): BulkImportAnalysis {
  const filenameSection = parseSectionFromFilename(filename)
  const page2Text = pageTexts[1] ?? ""
  const page1Text = pageTexts[0] ?? ""
  const pageSection = parseSectionFromPageText(page2Text)
    ?? parseSectionFromPageText(page1Text)
  // The form-typed Spec Section No. is the authoritative coversheet value —
  // it's what the human typed into the AcroForm widget. Use it first.
  const formSection = normalizeSpecSection(coverFields.specSectionNo)

  // Source priority: form (typed by human on the coversheet) → page text
  // label (scrape if form fields weren't recoverable) → filename (fallback).
  let suggestedSection: string | null = null
  let sectionSource: "form" | "page" | "filename" | "none" = "none"
  if (formSection) {
    suggestedSection = formSection
    sectionSource = "form"
  } else if (pageSection) {
    suggestedSection = pageSection
    sectionSource = "page"
  } else if (filenameSection.section) {
    suggestedSection = filenameSection.section
    sectionSource = "filename"
  }

  const sectionFlag = (() => {
    if (!suggestedSection) return true
    // Form is authoritative; only flag if the form value disagrees with the
    // filename (which would be a strange typo to highlight).
    if (sectionSource === "form" && filenameSection.section && formSection !== filenameSection.section) return true
    // Page-text + filename disagreement (legacy path) still worth flagging.
    if (sectionSource === "page" && filenameSection.section && pageSection !== filenameSection.section) return true
    // A loose 6-digit-only filename hit (with no form/page corroboration) is weak.
    if (sectionSource === "filename" && filenameSection.source === "loose-6digit") return true
    return false
  })()

  const typeGuess = detectSubmittalType(filename, [
    page1Text, page2Text,
    coverFields.specSectionTitle ?? "",  // form-field title carries strong type hints
  ].join("\n"))
  const suggestedType = typeGuess.type
  const typeFlag = !typeGuess.confident

  const cover = detectCoverSplit(pageTexts)

  // Pre-fill review-row fields from the recovered AcroForm values. User
  // confirms in the UI — these aren't committed automatically.
  const suggestedApprovalDate = normalizeApprovalDate(coverFields.dateSubmitted)
  const suggestedSubmittalNo  = coverFields.submittalNo?.trim() || null

  const notes: string[] = []
  if (sectionFlag) {
    if (!suggestedSection) {
      notes.push("Couldn't read a spec section from the coversheet form, page text, or filename.")
    } else if (sectionSource === "form" && filenameSection.section && formSection !== filenameSection.section) {
      notes.push(`Coversheet form says ${formSection}; filename suggests ${filenameSection.section}. Defaulted to the form value.`)
    } else if (sectionSource === "page" && filenameSection.section && pageSection !== filenameSection.section) {
      notes.push(`Filename suggests ${filenameSection.section}; coversheet text says ${pageSection}. Defaulted to the coversheet value.`)
    } else if (sectionSource === "filename" && filenameSection.source === "loose-6digit") {
      notes.push(`Section was guessed from a loose 6-digit run in the filename — no coversheet form value or labeled page text. Confirm before commit.`)
    }
  }
  if (typeFlag) notes.push("Couldn't infer the submittal type — pick one from the list.")
  if (cover.uncertain) notes.push(cover.reason)
  if (coverFields.dateSubmitted && !suggestedApprovalDate) {
    notes.push(`Coversheet date "${coverFields.dateSubmitted}" wasn't in a format we could parse — confirm in the date field.`)
  }

  // Surface a "positional guess" note when the date or submittal # came from
  // value-shape / widget-position inference (THP's generic Text1..Text10
  // names hit this path on every file). User sees a subtle styling on the
  // input AND a one-line nudge. Skipped when the value originated from a
  // real labeled field — those don't need second-guessing.
  if (
    suggestedSubmittalNo &&
    coverFieldsConfidence.submittalNo === "positional"
  ) notes.push(`Submittal # was guessed positionally — verify.`)
  if (
    suggestedApprovalDate &&
    coverFieldsConfidence.dateSubmitted === "positional"
  ) notes.push(`Approval date was guessed positionally — verify.`)

  // Suppress confidence for the date when our parser couldn't normalize it
  // — the input is empty and there's nothing to second-guess.
  const reportedApprovalDateConfidence: FieldConfidence = suggestedApprovalDate
    ? coverFieldsConfidence.dateSubmitted
    : "none"
  const reportedSubmittalNoConfidence: FieldConfidence = suggestedSubmittalNo
    ? coverFieldsConfidence.submittalNo
    : "none"

  return {
    pageCount: pageTexts.length,
    filename,
    suggestedSection,
    suggestedSectionDivision: suggestedSection ? divisionNameFor(suggestedSection) : null,
    formSection,
    filenameSection,
    pageSection,
    sectionSource,
    sectionFlag,
    suggestedType,
    typeGuess,
    typeFlag,
    cover,
    coverFields,
    suggestedApprovalDate,
    suggestedSubmittalNo,
    coverFieldsConfidence: {
      ...coverFieldsConfidence,
      dateSubmitted: reportedApprovalDateConfidence,
      submittalNo: reportedSubmittalNoConfidence,
    },
    needsAttention: sectionFlag || typeFlag || cover.uncertain,
    notes,
  }
}
