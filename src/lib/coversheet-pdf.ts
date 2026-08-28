import { PDF, PDFBuilder, type PDFStamp } from "./pdf-builder"
import type { SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"

// Review-language boilerplate printed in OUR stamp (top-left box). Kept here as a
// single exported constant so the wording is a one-line edit for the user.
export const SUBMITTAL_REVIEW_LANGUAGE =
  "This submittal has been reviewed, checked and approved for compliance with the Contract Documents unless otherwise noted herein. This review does not constitute, nor does it assure design responsibility, nor does it relieve the Trade Contractor/supplier from complying with the contract requirements, coordinating their work with other trade contractors and verifying field dimensions."

/** Reviewer-stamp identity, resolved server-side (never client-supplied). */
export interface CoversheetReviewer {
  company: string
  projectName: string
  projectNumber: string
  /** Pre-formatted "{section}-{num}.{rev}"; "" omits the row. */
  submittalNo: string
  reviewedBy: string
  /** Generation date, pre-formatted M/D/YYYY. */
  date: string
}

/**
 * Build the submittal coversheet PDF through the shared PDFBuilder design
 * system. Returns a single-page document; the generate-cover route merges it
 * in front of the original submittal PDF.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for the "Submittal Coversheet" template.
 * Every surface that prints a submittal cover renders it here:
 *   • /api/generate-cover            — the per-submittal cover
 *   • package mode 'per_item'        — one cover per emitted file
 * Package mode 'package' prints the SIBLING template below
 * (buildPackageCoversheetPdf): same chrome, one cover, a manifest table of
 * every submittal instead of the single-submittal field block.
 *
 * `generationDate` overrides the footer's "Generated <date>" (and the page-1
 * header meta line). Omit it — as /api/generate-cover does — and PDFBuilder
 * defaults to now(), so leaving it off is byte-identical to before it existed.
 * The merged package passes the package's send date so every cover in the one
 * document carries the same date.
 */
export async function buildCoversheetPdf(
  props: SubmittalCoversheetProps,
  logoBytes: ArrayBuffer | null = null,
  reviewer: CoversheetReviewer | null = null,
  logoScalePct?: number | null,
  generationDate?: Date,
): Promise<Uint8Array> {
  const {
    gcName,
    projectName, projectNumber, projectLocation,
    submittalDescription, specSectionTitle, specSectionNumber,
    submittalNumber, revisionNumber, dateSubmitted, submittalDueDate,
    criticalSubmittal = false, submittalPartyRequired = false, copyTo = "",
    stamps,
  } = props

  const pdf = await PDFBuilder.create({
    documentType: "Submittal Coversheet",
    logoBytes,
    brandName: gcName || null,
    // Enlarge the square company seal so it fills the header band and sits
    // centered against the title block (vs. the compact 34pt default). The
    // tenant's logo_scale_pct then multiplies this 42pt base, so the coversheet
    // seal stays proportionally larger than other docs while still scaling.
    logoMaxH: 42,
    logoScalePct: logoScalePct ?? undefined,
    generationDate,
  })

  // Project block
  pdf.projectBlock({
    name: projectName,
    number: projectNumber,
    location: projectLocation,
  })

  // Submittal block — one bordered grid: description, spec, numbers, dates,
  // the critical/party checkboxes, and copy-to.
  pdf.fieldGrid([
    [{ label: "Submittal Description", value: submittalDescription }],
    [{ label: "Spec Section Title", value: specSectionTitle }],
    [
      { label: "Spec Section No.", value: specSectionNumber },
      { label: "Submittal No.", value: submittalNumber },
      { label: "Revision No.", value: revisionNumber },
    ],
    [
      { label: "Date Submitted", value: dateSubmitted },
      { label: "Submittal Due Date", value: submittalDueDate },
    ],
    { checkboxes: [
      { label: "Critical Submittal", checked: criticalSubmittal },
      { label: "Submittal Party Required", checked: submittalPartyRequired },
    ] },
    [{ label: "Copy To", value: copyTo }],
  ])

  // Review-stamp grid (GC / Architect / Engineer / Subcontractor). When a
  // reviewer is supplied, OUR stamp fills the top-left (GC) box.
  const stampList: PDFStamp[] | undefined = stamps?.map(s => ({
    role: s.role,
    content: typeof s.content === "string" ? s.content : null,
  }))
  pdf.stampGrid(
    stampList,
    reviewer ? { ...reviewer, reviewText: SUBMITTAL_REVIEW_LANGUAGE } : null,
  )

  return pdf.save()
}

/** One manifest row on the package cover. A manual line (submittalId null) is
 *  description-only: it prints on the cover and contributes NO document. */
export interface PackageCoverLine {
  submittalId: string | null
  /** Padded section_seq; "" for a manual line. */
  submittalNumber: string
  specNumber: string
  specTitle: string
  description: string
  /** Pre-formatted M/D/YYYY; "" when the submittal has no due date. Per-row
   *  because a package carries many submittals with their own dates. */
  dueDate: string
}

/** Longest a single manifest cell may be — the table wraps, so this only guards
 *  against a pathological value growing the cover by pages. */
export const PACKAGE_COVER_LINE_MAX = 300

// Manifest column widths (pt): Submittal No. / Spec No. / Spec Title /
// Description / Due Date.
const PACKAGE_COVER_COLS = [66, 80, 122, 190, 68]

function cleanLineField(v: string, max = PACKAGE_COVER_LINE_MAX): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim().slice(0, max)
}

/**
 * Build the ONE cover for a merged ('package' mode) transmittal. Same PDFBuilder
 * chrome as buildCoversheetPdf — header, project block, dates/checkbox/copy-to
 * grid, 2×2 stamp grid — but the single-submittal description/spec/number block
 * is replaced by a "Submittals in this Package" manifest table with one row per
 * line. The table page-breaks (header repeats), and the stamp grid moves to a
 * fresh page when the manifest leaves too little room, so a long package never
 * clips. ONE package-level stamp, not one per item.
 *
 * `props` supplies the project/GC/date-submitted fields only; its
 * submittalDescription, specSection*, submittalNumber, revisionNumber and
 * submittalDueDate are unused here — the due date is PER SUBMITTAL, so it
 * prints in each manifest row, never in the package-level grid.
 */
export async function buildPackageCoversheetPdf(
  props: SubmittalCoversheetProps,
  lines: PackageCoverLine[],
  logoBytes: ArrayBuffer | null = null,
  reviewer: CoversheetReviewer | null = null,
  logoScalePct?: number | null,
  generationDate?: Date,
): Promise<Uint8Array> {
  const {
    gcName,
    projectName, projectNumber, projectLocation,
    dateSubmitted,
    criticalSubmittal = false, submittalPartyRequired = false, copyTo = "",
  } = props

  const colSum = PACKAGE_COVER_COLS.reduce((s, w) => s + w, 0)
  if (colSum !== PDF.contentW) {
    throw new Error(`Package cover manifest columns sum to ${colSum}, expected ${PDF.contentW}`)
  }

  const pdf = await PDFBuilder.create({
    documentType: "Submittal Coversheet",
    logoBytes,
    brandName: gcName || null,
    logoMaxH: 42,
    logoScalePct: logoScalePct ?? undefined,
    generationDate,
  })

  pdf.projectBlock({
    name: projectName,
    number: projectNumber,
    location: projectLocation,
  })

  pdf.fieldGrid([
    [{ label: "Date Submitted", value: dateSubmitted }],
    { checkboxes: [
      { label: "Critical Submittal", checked: criticalSubmittal },
      { label: "Submittal Party Required", checked: submittalPartyRequired },
    ] },
    [{ label: "Copy To", value: copyTo }],
  ])

  pdf.sectionDivider("Submittals in this Package")
  pdf.table(
    // Short labels: tableHeader clips (no wrap) at colW-12, so the two narrow
    // columns can't carry "Submittal No." / "Spec Section No." without an ellipsis.
    ["No.", "Spec No.", "Spec Title", "Submittal Description", "Due Date"],
    lines.map(l => [
      cleanLineField(l.submittalNumber, 40) || "—",
      cleanLineField(l.specNumber, 40) || "—",
      cleanLineField(l.specTitle) || "—",
      cleanLineField(l.description) || "—",
      cleanLineField(l.dueDate, 40) || "—",
    ]),
    PACKAGE_COVER_COLS,
  )

  pdf.stampGrid(
    undefined,
    reviewer ? { ...reviewer, reviewText: SUBMITTAL_REVIEW_LANGUAGE } : null,
  )

  return pdf.save()
}
