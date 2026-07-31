// AcroForm field extraction for the Bulk Import analyze route.
//
// THP signed-submittal PDFs (and most architect-supplied coversheets) are
// fillable PDF forms. The static labels — "Spec Section No.", "Date
// Submitted", "Project Name", etc. — live in the page content stream and
// extract fine through unpdf. But the values the user TYPED into those
// fields are stored separately as AcroForm widget annotations. Text-stream
// extractors don't surface them, which is why earlier diagnostic runs of
// the analyzer returned `pageSection = null` even when the user could
// plainly see `10 26 00` on page 2 of the PDF.
//
// pdf-lib (already a project dep — used to write submittal cover-sheets,
// transmittals, change-order PDFs, etc.) is the canonical way to read
// AcroForm fields without OCR. This module enumerates the form and returns
// a normalized CoversheetFields object the detector can use as its
// primary section source.
//
// Stage 2 (commit/strip) MUST call this BEFORE any coversheet stripping —
// once the pages are gone, the form widgets are gone too.

import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFDict, PDFArray } from "pdf-lib"
import type { CoversheetFields, CoversheetTemplate } from "./bulk-import-detect"
import { isSectionShape, VALID_DIVISIONS_FOR_SHAPE } from "./csi-section"

/** Architect-stamp information recovered from a PDF /Stamp annotation. */
export interface ApprovalStampInfo {
  /** YYYY-MM-DD — the PDF Stamp annotation's /CreationDate (when the
   *  architect applied the stamp). This IS the approval date. */
  date: string
  /** PDF /T field — the annotator's name. e.g. "Fernanda Alves". Null
   *  when the annotation didn't record it. */
  author: string | null
  /** 1-based page where the stamp annotation lives. Used by Stage 2b
   *  to anchor the cover-strip endpoint (strip through this page). */
  page: number
  /** Stamp template name (PDF /Name field). e.g. "Designer's Submittal
   *  Review", "Submittal Status". */
  stampName: string | null
}

/** Parse a PDF date string ("D:YYYYMMDDHHmmSS+OH'mm'") down to YYYY-MM-DD.
 *  Returns null when the input doesn't match the expected shape. */
function parsePdfDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).replace(/^\(?D:|\)$/g, "").replace(/['"]/g, "")
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function stringFromPdfText(raw: string | null | undefined): string | null {
  if (!raw) return null
  // pdf-lib stringifies as "(text)" or "<hex>" — strip the parens / brackets.
  let s = String(raw).trim()
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1)
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1)
  return s || null
}

/** Scan the first `maxPages` pages of a PDF for /Subtype = /Stamp
 *  annotations and return the EARLIEST stamp's metadata. The Stamp
 *  annotation's /CreationDate is set automatically by the PDF tool when
 *  the architect places the stamp — it IS the approval date.
 *
 *  Never throws — returns null when there is no AcroForm OR no stamp
 *  annotation is found OR pdf-lib fails to parse the file.
 *
 *  Reusable: Stage 2b's cover-split will use the same scan to anchor
 *  the strip endpoint (last front-matter page = page with the Stamp). */
export async function extractApprovalStampDate(
  buffer: Buffer,
  maxPages = 6,
): Promise<ApprovalStampInfo | null> {
  try {
    const doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    })
    const pages = doc.getPages()
    let best: ApprovalStampInfo | null = null
    const limit = Math.min(pages.length, maxPages)

    for (let p = 0; p < limit; p++) {
      const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
      if (!annotsRef) continue
      const annots = doc.context.lookup(annotsRef)
      if (!(annots instanceof PDFArray)) continue

      for (let i = 0; i < annots.size(); i++) {
        const annot = doc.context.lookup(annots.get(i))
        if (!(annot instanceof PDFDict)) continue
        const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
        if (subtype !== "/Stamp") continue

        const created = parsePdfDate(annot.get(doc.context.obj("CreationDate"))?.toString?.())
        if (!created) continue

        const info: ApprovalStampInfo = {
          date: created,
          author: stringFromPdfText(annot.get(doc.context.obj("T"))?.toString?.()),
          page: p + 1,
          stampName: stringFromPdfText(annot.get(doc.context.obj("Name"))?.toString?.()),
        }
        // Earliest stamp wins — submittal could have multiple disposition
        // overlays (re-stamped) but the first one is the original action.
        if (best === null || info.date < best.date) best = info
      }
    }
    return best
  } catch {
    return null
  }
}

/** A map of raw form-field name → raw value, normalized to strings. Empty
 *  when the PDF has no AcroForm or extraction failed for any reason. */
export type RawFormFields = Record<string, string>

/** Pull every form field's value out of a PDF. Never throws — a PDF
 *  without an AcroForm, with a malformed form, with encryption, or with
 *  any other pdf-lib hiccup just returns {} and the analyzer falls back
 *  to the page-text + filename path. */
export async function extractRawFormFields(buffer: Buffer): Promise<RawFormFields> {
  try {
    const doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    })
    const form = doc.getForm()
    const fields = form.getFields()
    const out: RawFormFields = {}
    for (const field of fields) {
      const name = field.getName()
      if (!name) continue
      let value: string | null = null
      if (field instanceof PDFTextField) {
        value = field.getText() ?? null
      } else if (field instanceof PDFDropdown) {
        const sel = field.getSelected()
        value = sel && sel.length > 0 ? sel.join(", ") : null
      } else if (field instanceof PDFOptionList) {
        const sel = field.getSelected()
        value = sel && sel.length > 0 ? sel.join(", ") : null
      } else if (field instanceof PDFCheckBox) {
        // Checkboxes don't carry typed values relevant to our match list;
        // surface as "true"/"" so a label fuzzy-match still works if needed.
        value = field.isChecked() ? "true" : ""
      }
      if (value && value.trim().length > 0) {
        out[name] = value.trim()
      }
    }
    return out
  } catch {
    return {}
  }
}

// ─── Label-aware lookup ─────────────────────────────────────────────────────
//
// PDF form authors don't use a standard schema — the field NAME (e.g.
// "specSectionNo", "Spec_Section_No", "Section #", "untitled14") rarely
// matches the visible label exactly. The lookup normalizes both sides and
// tries multiple candidate spellings per canonical field.

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function lookupField(
  raw: RawFormFields,
  ...candidates: string[]
): string | null {
  if (Object.keys(raw).length === 0) return null
  const normRaw = Object.entries(raw).map(([k, v]) => [normalizeKey(k), v] as const)
  // 1. Exact normalized-name match (strongest).
  for (const cand of candidates) {
    const target = normalizeKey(cand)
    for (const [k, v] of normRaw) if (k === target) return v
  }
  // 2. startsWith match — handles "specsectionno1", "specsectionnotypedhere"
  for (const cand of candidates) {
    const target = normalizeKey(cand)
    for (const [k, v] of normRaw) if (k.startsWith(target)) return v
  }
  // 3. substring match — last resort, lower confidence.
  for (const cand of candidates) {
    const target = normalizeKey(cand)
    for (const [k, v] of normRaw) if (k.includes(target)) return v
  }
  return null
}

// ─── Value-shape recovery (fallback for generic-named forms) ────────────────
//
// THP/BAM's coversheet template names its fields generically — Text1, Text2,
// …, Text10, "Text Field 5", "Text Field 6", etc. Label-based matching can't
// hit any of those. But the VALUES are unambiguous: only one field carries
// an `XX YY ZZ` section, dates have a known format, submittal #s are small
// integers. Scan every field and assign by shape when the label match fails.
//
// This is also more robust against future template revisions where a field
// gets renamed but its content stays the same shape.

// Section-shape check + valid-division set moved verbatim to
// src/lib/csi-section.ts (imported above) so client code can share them
// without pulling this module's pdf-lib import into the browser bundle.

const US_DATE_NUMERIC = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/
const US_DATE_MDY_DOTTED = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DD_MMM_YYYY = /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/   // "29 Dec 2025"
const MMM_DD_YYYY = /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/  // "Dec 29, 2025"
function isDateShape(v: string): boolean {
  const s = v.trim()
  return US_DATE_NUMERIC.test(s) || US_DATE_MDY_DOTTED.test(s) ||
         ISO_DATE.test(s) || DD_MMM_YYYY.test(s) || MMM_DD_YYYY.test(s)
}

const SUBMITTAL_NO_SHAPE = /^\d{1,3}$/

/** Try to sort a date-shaped string into something comparable. Returns
 *  YYYYMMDD or null. Coarse — we only need it to pick the latest. */
function dateSortKey(v: string): number | null {
  const s = v.trim()
  let m
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    const [, mo, d, y] = m
    const fullY = y.length === 4 ? y : (parseInt(y, 10) <= 50 ? "20" + y : "19" + y)
    return parseInt(fullY + mo.padStart(2, "0") + d.padStart(2, "0"), 10)
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    return parseInt(m[1] + m[2] + m[3], 10)
  }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/))) {
    const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase().startsWith(m![2].slice(0, 3).toLowerCase()))
    if (monthIdx >= 0) {
      return parseInt(m[3] + String(monthIdx + 1).padStart(2, "0") + m[1].padStart(2, "0"), 10)
    }
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase().startsWith(m![1].slice(0, 3).toLowerCase()))
    if (monthIdx >= 0) {
      return parseInt(m[3] + String(monthIdx + 1).padStart(2, "0") + m[2].padStart(2, "0"), 10)
    }
  }
  return null
}
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
]

interface ValueShapeMatches {
  specSection: string | null
  /** Date the architect signed off — the LATEST date-shaped value in the form.
   *  THP template: page-2 "Date Submitted" (Text9) is the contractor's
   *  submission; "Text Field 5" is the architect's review date. The latter is
   *  always later. Generalizes: latest date in any coversheet form is the
   *  most authoritative approval date. */
  approvalDate: string | null
  /** Submittal number — the first small-int field that comes AFTER the
   *  section field in the form's widget order. THP's coversheet stores
   *  Revision-No. BEFORE Section-No. (both are 1-3 digit ints), so taking
   *  "first small int anywhere" picks the revision instead of the submittal.
   *  Relying on insertion order matches how the form was authored. */
  submittalNo: string | null
}

function recoverByValueShape(raw: RawFormFields): ValueShapeMatches {
  const entries = Object.entries(raw)
  let specSection: string | null = null
  let sectionFieldIdx = -1
  const dates: { value: string; key: number }[] = []

  for (let i = 0; i < entries.length; i++) {
    const value = entries[i][1]
    if (!specSection && isSectionShape(value)) {
      specSection = value
      sectionFieldIdx = i
    }
    if (isDateShape(value)) {
      const key = dateSortKey(value)
      if (key !== null) dates.push({ value, key })
    }
  }

  // Submittal #: the first 1-3 digit field whose index in the form's widget
  // order is AFTER the section. On the THP template the layout is:
  //
  //   Spec Section Title [...] Revision No [Text6] Spec Section No [Text7]
  //   Submittal No [Text8] Date Submitted [Text9] Submittal Due Date [Text10]
  //
  // so iterating from sectionFieldIdx+1 forward picks Text8 (submittal),
  // not Text6 (revision). Falls back to a no-positional first-small-int
  // search if the section wasn't found via value shape.
  let submittalNo: string | null = null
  const start = sectionFieldIdx >= 0 ? sectionFieldIdx + 1 : 0
  for (let i = start; i < entries.length; i++) {
    const v = entries[i][1].trim()
    if (SUBMITTAL_NO_SHAPE.test(v) && (!specSection || v !== specSection.slice(-2))) {
      submittalNo = v
      break
    }
  }

  // Latest date wins for approval.
  let approvalDate: string | null = null
  if (dates.length > 0) {
    dates.sort((a, b) => b.key - a.key)
    approvalDate = dates[0].value
  }

  return { specSection, approvalDate, submittalNo }
}

/** Recover the project-name and section-title by value shape. The THP
 *  template stores both in early Text1/Text5 positions, before any digits.
 *  Heuristic: the FIRST string-typed field is the project name; the
 *  field immediately PRECEDING the section field (in widget order) is the
 *  section title. Both are nice-to-haves for review-row pre-fill, so we
 *  return null when the heuristic doesn't have enough signal. */
function recoverStringsByPosition(raw: RawFormFields, sectionFieldIdx: number): {
  projectName: string | null
  specSectionTitle: string | null
} {
  const entries = Object.entries(raw)
  let projectName: string | null = null
  for (const [, v] of entries) {
    if (/[A-Za-z]/.test(v) && v.length >= 3 && !isSectionShape(v) && !isDateShape(v) && !/^\d+$/.test(v)) {
      projectName = v
      break
    }
  }
  let specSectionTitle: string | null = null
  if (sectionFieldIdx > 0) {
    for (let i = sectionFieldIdx - 1; i >= 0; i--) {
      const v = entries[i][1].trim()
      if (/[A-Za-z]/.test(v) && v.length >= 3 && !isSectionShape(v) && !isDateShape(v) && !/^\d+$/.test(v)) {
        specSectionTitle = v
        break
      }
    }
  }
  return { projectName, specSectionTitle }
}

/** Per-field confidence from the recovery step. "label" means the value
 *  came from a real labeled field hit OR from a known coversheet template's
 *  fixed field map (e.g. Waters' Text5=submittalNo) — treat as confirmed.
 *  "positional" means value-shape / widget-position inference on a template
 *  we couldn't identify — render as unconfirmed in the review row. "none"
 *  means nothing was found. */
export type FieldConfidence = "label" | "positional" | "none"

export interface CoversheetFieldsConfidence {
  specSectionNo:    FieldConfidence
  specSectionTitle: FieldConfidence
  submittalNo:      FieldConfidence
  dateSubmitted:    FieldConfidence
  projectName:      FieldConfidence
  submitter:        FieldConfidence
}

export interface CoversheetRecovery {
  fields: CoversheetFields
  confidence: CoversheetFieldsConfidence
  template: CoversheetTemplate
  /** Sections beyond the primary (e.g. Waters Sub 158 lists
   *  "09-67-23 & 09-65-19"). Primary = `fields.specSectionNo`; the rest
   *  go here so the analyzer can flag a multi-section row. */
  additionalSections: string[]
}

const EMPTY_CONFIDENCE: CoversheetFieldsConfidence = {
  specSectionNo: "none", specSectionTitle: "none", submittalNo: "none",
  dateSubmitted: "none", projectName: "none", submitter: "none",
}

// ─── Template detection + per-template field maps ──────────────────────────
//
// The bulk-import flow has seen TWO distinct fillable-PDF coversheets:
//
//   "bam-thp" (the architect/owner-side BAM template) — section as bare
//     `XX YY ZZ` in Text7, submittal# in Text8, date in Text9, title in
//     Text5, project in Text1. Field names are generic (Text1..Text10).
//
//   "waters" (the GC/Waters Construction Co. submitter coversheet) —
//     section as free-text "Division XX; Section XX-XX-XX" (sometimes
//     with a leading item number and an "& XX-XX-XX" for multi-section)
//     in Text6, submittal# in Text5, date in Text4, title in Text8,
//     submitter (the GC) in Text1. Names are Text1#1..Text10#1 in some
//     PDFs (pdf-lib widget naming quirk) — match both forms.
//
// Detection is by content shape, not field name:
//
//   - Waters: any field carries a dashed `XX-XX-XX` whose leading two
//     digits are a real CSI division. Distinguishes from BAM, which uses
//     space-separated `XX YY ZZ`.
//   - BAM: any field IS exactly bare `XX YY ZZ` (full-string).
//
// Once detected, the matching field-map extractor runs. The map is keyed
// by the known field NAMES (Text4/5/6/8/1), with #1 suffix tried as a
// fallback. Confidence is "label" on a template match (we know the map)
// and "positional" only when template is unknown.

const VALID_DIVISIONS_FOR_TEMPLATE = VALID_DIVISIONS_FOR_SHAPE
const WATERS_DASHED_SECTION_RE = /(\d{2})-(\d{2})-(\d{2})(?!\d)/

function detectTemplate(raw: RawFormFields): CoversheetTemplate {
  // Waters first — dashed sections are a strong template signature.
  for (const v of Object.values(raw)) {
    const m = v.match(WATERS_DASHED_SECTION_RE)
    if (m && VALID_DIVISIONS_FOR_TEMPLATE.has(m[1])) return "waters"
  }
  // BAM — any bare XX YY ZZ value.
  for (const v of Object.values(raw)) {
    if (isSectionShape(v)) return "bam-thp"
  }
  return "unknown"
}

function lookupByExactName(raw: RawFormFields, ...candidates: string[]): string | null {
  for (const name of candidates) {
    const v = raw[name]
    if (v && v.trim().length > 0) return v.trim()
  }
  return null
}

/** Recover the Waters template's NICE-TO-HAVE fields by their fixed-position
 *  field names. Section is NOT pulled here — the analyzer runs a
 *  template-agnostic CSI extractor (`extractCsiSectionFromCoversheet`)
 *  against the raw form values + coversheet pages, so adding new templates
 *  doesn't require a new section handler. We keep template detection so
 *  that submitter / title / submittal# / date can pre-fill confidently
 *  from a known field map. */
function recoverWatersFields(raw: RawFormFields): CoversheetFields {
  return {
    specSectionNo:    null,  // not surfaced from here; generic extractor handles it
    specSectionTitle: lookupByExactName(raw, "Text8#1", "Text8"),
    submittalNo:      lookupByExactName(raw, "Text5#1", "Text5"),
    dateSubmitted:    lookupByExactName(raw, "Text4#1", "Text4"),
    // Waters template doesn't carry a project / facility name in the form.
    // Stage 2 derives project from the user's selected project-id at
    // commit time, not from the coversheet.
    projectName:      null,
    submitter:        lookupByExactName(raw, "Text1#1", "Text1"),
  }
}

/** Recover the coversheet's structured values. Detects the template first
 *  (Waters vs BAM/THP) and runs the matching extractor. Returns a
 *  confidence map so the review row knows whether each value was
 *  authoritatively recovered or just a value-shape guess. */
export function recoverCoversheetFields(raw: RawFormFields): CoversheetRecovery {
  const template = detectTemplate(raw)

  if (template === "waters") {
    const fields = recoverWatersFields(raw)
    // Every nice-to-have on Waters comes from the known template map →
    // "label" confidence when present. Section is handled by the generic
    // CSI extractor in the analyzer; specSectionNo here is null so the
    // confidence map reports "none" for it (the analyzer doesn't consume
    // confidence for section).
    return {
      fields,
      confidence: {
        specSectionNo:    "none",
        specSectionTitle: fields.specSectionTitle ? "label" : "none",
        submittalNo:      fields.submittalNo      ? "label" : "none",
        dateSubmitted:    fields.dateSubmitted    ? "label" : "none",
        projectName:      "none",
        submitter:        fields.submitter        ? "label" : "none",
      },
      template,
      additionalSections: [],
    }
  }

  const labelHits: CoversheetFields = {
    specSectionNo: lookupField(raw,
      "Spec Section No", "Specification Section No", "Section No",
      "Spec Section Number", "SpecSectionNo",
    ),
    specSectionTitle: lookupField(raw,
      "Spec Section Title", "Section Title", "Specification Section Title",
      "SpecSectionTitle",
    ),
    submittalNo: lookupField(raw,
      "Submittal No", "Submittal Number", "SubmittalNo", "Sub No", "Submittal #",
    ),
    dateSubmitted: lookupField(raw,
      "Date Submitted", "Submitted Date", "DateSubmitted", "Date", "Submitted On",
    ),
    projectName: lookupField(raw,
      "Project Name", "ProjectName", "Project",
    ),
    submitter: null,  // No semantic field label for "submitter" on the BAM template.
  }

  // Where labels didn't hit, fall back to value-shape recovery.
  const shape = recoverByValueShape(raw)
  // Resolve the section's position so we can also fish out the title (the
  // string field immediately before it in widget order on the THP template).
  let sectionFieldIdx = -1
  if (!labelHits.specSectionTitle || !labelHits.projectName) {
    const entries = Object.entries(raw)
    for (let i = 0; i < entries.length; i++) {
      if (isSectionShape(entries[i][1])) { sectionFieldIdx = i; break }
    }
  }
  const strings = recoverStringsByPosition(raw, sectionFieldIdx)

  const fields: CoversheetFields = {
    specSectionNo:    labelHits.specSectionNo    ?? shape.specSection,
    specSectionTitle: labelHits.specSectionTitle ?? strings.specSectionTitle,
    submittalNo:      labelHits.submittalNo      ?? shape.submittalNo,
    // approval date — LATEST date in the form, which on the THP template
    // is the architect's signoff (page-1 stamp), not the contractor's
    // "Date Submitted" (page 2). See ValueShapeMatches comment.
    dateSubmitted:    labelHits.dateSubmitted    ?? shape.approvalDate,
    projectName:      labelHits.projectName      ?? strings.projectName,
    // BAM template doesn't carry a separate submitter field.
    submitter:        null,
  }
  const confidence: CoversheetFieldsConfidence = {
    specSectionNo:    labelHits.specSectionNo    ? "label" : shape.specSection      ? "positional" : "none",
    specSectionTitle: labelHits.specSectionTitle ? "label" : strings.specSectionTitle ? "positional" : "none",
    submittalNo:      labelHits.submittalNo      ? "label" : shape.submittalNo      ? "positional" : "none",
    dateSubmitted:    labelHits.dateSubmitted    ? "label" : shape.approvalDate     ? "positional" : "none",
    projectName:      labelHits.projectName      ? "label" : strings.projectName    ? "positional" : "none",
    submitter:        "none",
  }
  return { fields, confidence, template, additionalSections: [] }
}

export { EMPTY_CONFIDENCE }
