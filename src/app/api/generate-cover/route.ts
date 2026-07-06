import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { type SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"
import { buildCoversheetPdf, type CoversheetReviewer } from "@/lib/coversheet-pdf"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"

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
    contentSource,
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
    .select("logo_path, logo_scale_pct")
    .maybeSingle()

  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: logoBlob } = await supabase.storage
      .from("company-assets")
      .download(settings.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  // ── Reviewer stamp identity — resolved SERVER-SIDE from the session. The
  // generating user's full name and their company name are NEVER taken from the
  // client; we read them from the authenticated user's own user_profiles row and
  // the companies table for their company_id.
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  let stampCompanyName = ""
  if (companyId) {
    const { data: companyRow } = await supabase
      .from("companies").select("name").eq("id", companyId).maybeSingle()
    stampCompanyName = companyRow?.name ?? ""
  }
  const { data: profile } = await supabase
    .from("user_profiles").select("full_name").maybeSingle()
  const reviewedByName = profile?.full_name ?? ""

  // Stamp's Submittal No. — "{spec section}-{submittal}.{revision}" (e.g.
  // "07 84 40-7.0"). Omit any part that's missing; an empty string omits the row.
  const secPart = (specSectionNo ?? "").trim()
  const subInt = parseInt(String(submittalNo ?? ""), 10)
  const numPart = Number.isFinite(subInt)
    ? `${subInt}.${parseInt(String(revisionNo ?? "0"), 10) || 0}`
    : ""
  const stampSubmittalNo = [secPart, numPart].filter(Boolean).join("-")

  const reviewer: CoversheetReviewer = {
    company:       stampCompanyName,
    projectName:   projectName   || "",
    projectNumber: projectNumber || "",
    submittalNo:   stampSubmittalNo,
    reviewedBy:    reviewedByName,
    date:          new Date().toLocaleDateString("en-US"),
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

  const coverBytes = await buildCoversheetPdf(coversheetProps, logoBytes, reviewer, settings?.logo_scale_pct ?? undefined)

  // Merge cover page with original submittal PDF (if any)
  const mergedDoc = await PDFDocument.create()
  const coverDoc = await PDFDocument.load(coverBytes)
  const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
  coverPages.forEach(p => mergedDoc.addPage(p))

  if (submittalId) {
    try {
      const { data: submittalRow } = await supabase
        .from("submittals")
        .select("storage_path, stripped_storage_path, mime_type")
        .eq("id", submittalId)
        .maybeSingle()

      // Which stored copy the cover is merged onto is the CALLER's choice:
      //   contentSource "original" → storage_path, the record-of-truth file
      //     exactly as uploaded ("Original (w/ stamp)" — incl. any existing
      //     coversheet/stamp pages).
      //   contentSource "stripped" (or absent — legacy callers) → the
      //     strip-at-upload Library copy when one exists, falling back to the
      //     original when nothing was stripped (raw datasheet, or a deferred
      //     image-cover). This keeps that output [new cover] → [clean product]
      //     instead of stacking the new cover on the old coversheet.
      const contentPath = contentSource === "original"
        ? submittalRow?.storage_path
        : (submittalRow?.stripped_storage_path || submittalRow?.storage_path)

      if (contentPath && submittalRow?.mime_type === "application/pdf") {
        const { data: submittalBlob } = await supabase.storage
          .from("submittals")
          .download(contentPath)

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

  // Record the generated transmittal onto an EXISTING log row ONLY.
  //
  // We never CREATE a submittals row here. Generating a cover for a Library
  // SHELF item (no existingId) is a download/send action, not a submittal
  // transaction — it must not file a phantom log row, and must not leave a
  // phantom PDF under project-submittals/ with no row pointing at it. So the
  // whole save block is gated on `existingId`: only the project-log
  // "Cover"/"Transmit" flow (which passes an already-real log row) records
  // its transmittal here. The shelf-Cover flow falls straight through to the
  // PDF download below.
  if (projectId && existingId) {
    try {
      const { data: companyId } = await supabase.rpc("get_my_company_id")
      if (!companyId) throw new Error("No company association")
      const safeName = (description ?? "submittal").replace(/[^a-zA-Z0-9._-]/g, "_")
      // Tenant-isolated path (new storage RLS uses (storage.foldername)[1]).
      const storagePath = `${companyId}/project-submittals/${projectId}/${Date.now()}_${safeName}_transmittal.pdf`

      await supabase.storage.from("submittals").upload(storagePath, finalBytes, {
        contentType: "application/pdf",
        upsert: false,
      })

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

      const displayTitle = normalizeSubmittalTitle(description) || safeName

      await supabase.from("submittals").update({
        file_name:    displayTitle,
        storage_path: storagePath,
        mime_type:    "application/pdf",
        project_id:   projectId,
        review_status: "Received",
        ...transmittalFields,
      }).eq("id", existingId)
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
