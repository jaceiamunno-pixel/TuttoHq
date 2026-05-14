import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { PDFBuilder } from "@/lib/pdf-builder"

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const {
    submittalId,
    projectId,
    existingId,
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

  // Save merged PDF to project submittal log if a project was selected
  if (projectId) {
    try {
      const safeName = (description ?? "submittal").replace(/[^a-zA-Z0-9._-]/g, "_")
      const storagePath = `project-submittals/${projectId}/${Date.now()}_${safeName}_transmittal.pdf`

      await supabase.storage.from("submittals").upload(storagePath, finalBytes, {
        contentType: "application/pdf",
        upsert: false,
      })

      const targetId = existingId || null

      if (targetId) {
        // UPDATE the existing record (e.g. after direct upload or editing a cover sheet)
        await supabase.from("submittals").update({
          file_name:    description?.trim() || safeName,
          storage_path: storagePath,
          mime_type:    "application/pdf",
          project_id:   projectId,
          review_status: "Received",
        }).eq("id", targetId)
      } else if (submittalId) {
        // INSERT a new project record linked from a library item
        const { data: orig } = await supabase.from("submittals")
          .select("csi_division, division_name, csi_section, section_name, material_name, manufacturer, dimensions")
          .eq("id", submittalId).maybeSingle()

        await supabase.from("submittals").insert({
          file_name:     description?.trim() || safeName,
          storage_path:  storagePath,
          mime_type:     "application/pdf",
          csi_division:  orig?.csi_division  ?? null,
          division_name: orig?.division_name ?? null,
          csi_section:   orig?.csi_section   ?? null,
          section_name:  orig?.section_name  ?? null,
          material_name: orig?.material_name ?? null,
          manufacturer:  orig?.manufacturer  ?? null,
          dimensions:    orig?.dimensions    ?? null,
          project_id:    projectId,
          status:        "active",
          review_status: "Received",
          uploaded_by:   user.id,
        })
      }
    } catch {
      // Non-fatal: PDF still downloads even if DB save fails
    }
  }

  return new NextResponse(Buffer.from(finalBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
