import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { type SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"
import { buildCoversheetPdf, type CoversheetReviewer } from "@/lib/coversheet-pdf"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"
import { padSectionSeq } from "@/lib/section-number"

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
    .from("user_profiles").select("full_name").eq("user_id", user.id).maybeSingle()
  const reviewedByName = profile?.full_name ?? ""

  // Stamp's Submittal No. — "{spec section}-{section_seq:3}.{revision}" (e.g.
  // "10 44 00-004.0"). PADDED to 3 digits so it matches the log / every other
  // printed surface and the convention already in the imported data
  // (092116-001.0). Omit any part that's missing; an empty string omits the row.
  const secPart = (specSectionNo ?? "").trim()
  const subInt = parseInt(String(submittalNo ?? ""), 10)
  const numPart = Number.isFinite(subInt)
    ? `${padSectionSeq(subInt)}.${parseInt(String(revisionNo ?? "0"), 10) || 0}`
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
    submittalNumber:       Number.isFinite(subInt) ? padSectionSeq(subInt) : "",
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

  // Record the generated transmittal.
  //
  //   existingId  → UPDATE that log row (project-log "Cover"/"Transmit" on an
  //     already-real row — the legit transmittal-record path, unchanged).
  //   no existingId, but a source submittalId → INSERT a submittal_revisions
  //     row NESTED under the parent (shelf Cover / batch cover queue). We
  //     still never CREATE a submittals row here — that was the orphan-log-row
  //     bug (fixed 8014dd6 by recording nothing; recorded properly since
  //     migration 0055 gave cover issues their own child table). Revisions
  //     live in their own table so closeout/packages/exports/counts, which
  //     query submittals only, stay correct.
  //   no projectId (settings preview, shelf Cover without a project picked)
  //     → pure download, nothing stored.
  if (projectId && (existingId || submittalId)) {
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

      if (existingId) {
        const displayTitle = normalizeSubmittalTitle(description) || safeName

        await supabase.from("submittals").update({
          file_name:    displayTitle,
          storage_path: storagePath,
          mime_type:    "application/pdf",
          project_id:   projectId,
          review_status: "Received",
          ...transmittalFields,
        }).eq("id", existingId)
      } else {
        // company_id is NEVER sent — the column defaults to
        // get_my_company_id() and RLS scopes on it.
        const nextRevSeq = async (): Promise<number> => {
          const { data } = await supabase
            .from("submittal_revisions")
            .select("rev_seq")
            .eq("submittal_id", submittalId)
            .order("rev_seq", { ascending: false })
            .limit(1)
            .maybeSingle()
          return (data?.rev_seq ?? -1) + 1
        }
        const revRow = {
          submittal_id:   submittalId,
          storage_path:   storagePath,
          file_name:      (typeof description === "string" && description.trim()) || safeName,
          mime_type:      "application/pdf",
          cover_pdf_path: storagePath,
          review_status:  "Received",
          created_by:     user.id,
          copy_to:        copyTo || null,
          ...transmittalFields,
        }
        // Same derive-and-retry-once idiom as RFI/CO/Sub-CO numbering: two
        // browsers can derive the same rev_seq; on the unique violation
        // re-read and retry exactly once, then surface a 409.
        let { error } = await supabase.from("submittal_revisions")
          .insert({ ...revRow, rev_seq: await nextRevSeq() })
        if (error?.code === "23505") {
          const retry = await supabase.from("submittal_revisions")
            .insert({ ...revRow, rev_seq: await nextRevSeq() })
          error = retry.error
        }
        if (error?.code === "23505") {
          return NextResponse.json(
            { error: "A revision was recorded for this submittal at the same moment — please try again" },
            { status: 409 },
          )
        }
        // Any other insert error is non-fatal — the PDF still downloads.
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
