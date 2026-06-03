import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"

export async function GET(
  req: NextRequest,
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

  // Historical-revision download: when ?path=… is supplied, override
  // submittal.storage_path with that value AFTER validating the path is
  // a real attachment on this submittal (RLS-filtered). Defends against
  // a crafted query attempting to download an arbitrary storage object.
  const requestedPath = new URL(req.url).searchParams.get("path")
  let useStoragePath = submittal.storage_path
  let useFileName = submittal.file_name
  if (requestedPath && requestedPath !== submittal.storage_path) {
    const { data: att } = await supabase
      .from("submittal_attachments")
      .select("storage_path, file_name")
      .eq("submittal_id", id)
      .eq("storage_path", requestedPath)
      .maybeSingle()
    if (!att) return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    useStoragePath = att.storage_path
    useFileName    = att.file_name
  }
  // Continue with `useStoragePath` / `useFileName` for the rest of the
  // route. The variables `submittal.storage_path` / `file_name` are
  // shadowed below.
  submittal.storage_path = useStoragePath
  submittal.file_name    = useFileName

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

return new NextResponse(Buffer.from(mergedBytes), {    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${submittal.file_name}"`,
    },
  })
}
