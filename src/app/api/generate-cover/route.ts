import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { PDFBuilder } from "@/lib/pdf-builder"

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const body = await req.json()
  const {
    submittalId,
    projectName,
    projectNumber,
    projectLocation,
    gcName,
    architect,
    specSectionNo,
    specSectionTitle,
    description,
    dateSubmitted,
    submittalNo,
    reviewedBy,
    certifiedBy,
    notes,
  } = body

  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path")
    .eq("id", 1)
    .maybeSingle()

  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: logoBlob } = await supabase.storage
      .from("company-assets")
      .download(settings.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  const b = await PDFBuilder.create("SUBMITTAL TRANSMITTAL", logoBytes)

  if (projectName || projectNumber) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", projectName ?? "—", 65, "Project No.", projectNumber ?? "—", 35)
    if (projectLocation) b.oneCol("Project Location", projectLocation)
    if (gcName || architect)
      b.twoCol("General Contractor", gcName ?? "—", 50, "Architect", architect ?? "—", 50)
    b.gap()
  }

  b.sectionHeader("SUBMITTAL INFORMATION")
  b.twoCol("Spec Section No.", specSectionNo ?? "—", 30, "Spec Section Title", specSectionTitle ?? "—", 70)
  b.oneCol("Submittal Description", description ?? "")
  b.twoCol("Date Submitted", dateSubmitted ?? "—", 50, "Submittal No.", submittalNo ?? "—", 50)
  b.gap()

  b.sectionHeader("REVIEW / CERTIFICATION")
  b.twoCol("Reviewed By", reviewedBy ?? "—", 50, "Certified by CQM", certifiedBy ?? "—", 50)
  b.gap()

  if (notes?.trim()) b.textBlock("NOTES", notes)

  b.signatureLines("Reviewed By / Date", "Approved By / Date")

  const coverBytes = await b.save()

  // Merge cover page with original submittal PDF (if any)
  const mergedDoc = await PDFDocument.create()
  const coverDoc = await PDFDocument.load(coverBytes)
  const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
  coverPages.forEach(p => mergedDoc.addPage(p))

  if (submittalId) {
    try {
      const { data: submittalRow } = await supabase
        .from("submittals")
        .select("storage_path, mime_type")
        .eq("id", submittalId)
        .maybeSingle()

      if (submittalRow?.storage_path && submittalRow.mime_type === "application/pdf") {
        const { data: submittalBlob } = await supabase.storage
          .from("submittals")
          .download(submittalRow.storage_path)

        if (submittalBlob) {
          const submittalPdfBytes = await submittalBlob.arrayBuffer()
          const submittalDoc = await PDFDocument.load(submittalPdfBytes)
          const submittalPages = await mergedDoc.copyPages(submittalDoc, submittalDoc.getPageIndices())
          submittalPages.forEach(p => mergedDoc.addPage(p))
        }
      }
    } catch {
      // If merging fails, return cover sheet only
    }
  }

  const finalBytes = await mergedDoc.save()
  const filename = submittalId ? "submittal_transmittal.pdf" : "cover_sheet.pdf"

  return new NextResponse(Buffer.from(finalBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
