import { PDFBuilder, type PDFStamp } from "./pdf-builder"
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
 */
export async function buildCoversheetPdf(
  props: SubmittalCoversheetProps,
  logoBytes: ArrayBuffer | null = null,
  reviewer: CoversheetReviewer | null = null,
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
    // centered against the title block (vs. the compact 34pt default).
    logoMaxH: 42,
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
