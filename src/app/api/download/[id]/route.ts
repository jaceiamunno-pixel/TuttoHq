import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: submittal } = await supabase
    .from("submittals")
    .select("file_name, storage_path, mime_type")
    .eq("id", id)
    .single()

  if (!submittal?.storage_path) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  // Non-PDFs — redirect to signed URL
  if (submittal.mime_type !== "application/pdf") {
    const { data: urlData } = await supabase.storage
      .from("submittals")
      .createSignedUrl(submittal.storage_path, 3600)
    if (!urlData?.signedUrl) return NextResponse.json({ error: "URL generation failed" }, { status: 500 })
    return NextResponse.redirect(urlData.signedUrl)
  }

  // Check for cover page
  const { data: settings } = await supabase
    .from("company_settings")
    .select("cover_page_path")
    .eq("id", 1)
    .maybeSingle()

  // No cover page — redirect to signed URL
  if (!settings?.cover_page_path) {
    const { data: urlData } = await supabase.storage
      .from("submittals")
      .createSignedUrl(submittal.storage_path, 3600)
    if (!urlData?.signedUrl) return NextResponse.json({ error: "URL generation failed" }, { status: 500 })
    return NextResponse.redirect(urlData.signedUrl)
  }

  // Download both PDFs in parallel
  const [{ data: submittalBlob, error: e1 }, { data: coverBlob, error: e2 }] = await Promise.all([
    supabase.storage.from("submittals").download(submittal.storage_path),
    supabase.storage.from("company-assets").download(settings.cover_page_path),
  ])

  if (!submittalBlob || !coverBlob || e1 || e2) {
    console.error("PDF download failed", e1, e2)
    return NextResponse.json({ error: "Download failed" }, { status: 500 })
  }

  // Merge with pdf-lib: cover page first, then submittal
  const [submittalBytes, coverBytes] = await Promise.all([
    submittalBlob.arrayBuffer(),
    coverBlob.arrayBuffer(),
  ])

  const coverDoc    = await PDFDocument.load(coverBytes)
  const submittalDoc = await PDFDocument.load(submittalBytes)
  const mergedDoc   = await PDFDocument.create()

  const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
  coverPages.forEach(p => mergedDoc.addPage(p))

  const submittalPages = await mergedDoc.copyPages(submittalDoc, submittalDoc.getPageIndices())
  submittalPages.forEach(p => mergedDoc.addPage(p))

  const mergedBytes = await mergedDoc.save()

  return new NextResponse(mergedBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${submittal.file_name}"`,
    },
  })
}
