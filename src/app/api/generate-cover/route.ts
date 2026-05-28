import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { type SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"
import { buildCoversheetPdf } from "@/lib/coversheet-pdf"

export const maxDuration = 60

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
    revisionNo,
    dueDate,
    isCritical,
    partyRequired,
    copyTo,
    reviewedBy,
    certifiedBy,
    notes,
    sendToType,
    sendToCompany,
    sendToContact,
    sendToEmail,
    sendToPhone,
    sendToAddress,
    transmittedBy,
    transmittedByCompany,
  } = body

  // Fetch company logo as raw bytes
  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path")
    .maybeSingle()

  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: logoBlob } = await supabase.storage
      .from("company-assets")
      .download(settings.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  const coversheetProps: SubmittalCoversheetProps = {
    gcName:                gcName         || "",
    projectName:           projectName    || "",
    projectNumber:         projectNumber  || "",
    projectLocation:       projectLocation || "",
    submittalDescription:  description    || "",
    specSectionTitle:      specSectionTitle || "",
    specSectionNumber:     specSectionNo  || "",
    submittalNumber:       String(Math.max(1, parseInt(submittalNo || "1", 10) || 1)).padStart(2, "0"),
    revisionNumber:        String(parseInt(revisionNo || "0", 10) || 0).padStart(2, "0"),
    dateSubmitted:         dateSubmitted  || "",
    submittalDueDate:      dueDate        || "",
    criticalSubmittal:     !!isCritical,
    submittalPartyRequired: !!partyRequired,
    copyTo:                copyTo         || "",
  }

  const coverBytes = await buildCoversheetPdf(coversheetProps, logoBytes)

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
          const submittalDoc = await PDFDocument.load(await submittalBlob.arrayBuffer())
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

      const transmittalFields = {
        send_to_type:           sendToType    || null,
        send_to_company:        sendToCompany || null,
        send_to_contact:        sendToContact || null,
        send_to_email:          sendToEmail   || null,
        send_to_phone:          sendToPhone   || null,
        send_to_address:        sendToAddress || null,
        transmitted_by:         transmittedBy || null,
        transmitted_by_company: transmittedByCompany || null,
      }

      if (targetId) {
        await supabase.from("submittals").update({
          file_name:    description?.trim() || safeName,
          storage_path: storagePath,
          mime_type:    "application/pdf",
          project_id:   projectId,
          review_status: "Received",
          ...transmittalFields,
        }).eq("id", targetId)
      } else if (submittalId) {
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
          ...transmittalFields,
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
