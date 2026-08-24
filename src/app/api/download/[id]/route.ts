import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"

// GET /api/download/[id]
//
// ROBUSTNESS CONTRACT: a submittal that has a stored file is ALWAYS
// openable. No code path returns 500 for a bad/large PDF — every branch
// falls back to a plain signed-URL redirect of the original. The only
// non-200 outcomes are 404 (no file at all) and 502 (storage itself
// unreachable, so nothing can be served).
//
// Stripping does NOT happen here anymore. The Library "stripped" view is
// generated ONCE at upload and stored (submittals.stripped_storage_path);
// this route just serves that stored object. Running unpdf/pdf-lib strip
// in the request used to cause process-level crashes (OOM / pdf.js worker
// death) that a try/catch can't trap → 500 on every open. Serving a stored
// file can't crash on a bad PDF.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: submittal } = await supabase
    .from("submittals")
    .select("file_name, storage_path, mime_type, stripped_storage_path")
    .eq("id", id)
    .single()

  if (!submittal) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const url = new URL(req.url)
  const stripped = url.searchParams.get("stripped") === "1"
  const requestedPath = url.searchParams.get("path")

  // Universal safe fallback: redirect to a 1-hour signed URL for a stored
  // object. Plain download, no PDF processing — cannot crash on a bad file.
  async function signedRedirect(path: string): Promise<NextResponse | null> {
    const { data } = await supabase.storage.from("submittals").createSignedUrl(path, 3600)
    return data?.signedUrl ? NextResponse.redirect(data.signedUrl) : null
  }
  const storageDown = () => NextResponse.json({ error: "storage unavailable" }, { status: 502 })

  // ── Historical-revision download (?path=…): validate the path is a real
  //    attachment OR a submittal_revisions cover on this submittal (defends
  //    against arbitrary-object reads), then serve it raw via signed
  //    redirect. Checked BEFORE the storage_path gate below — a revision can
  //    hang off a parent that has no file of its own (spec placeholder that
  //    only ever had covers generated).
  if (requestedPath && requestedPath !== submittal.storage_path) {
    const { data: att } = await supabase
      .from("submittal_attachments")
      .select("storage_path")
      .eq("submittal_id", id)
      .eq("storage_path", requestedPath)
      .maybeSingle()
    if (att) return (await signedRedirect(att.storage_path)) ?? storageDown()

    // Two chained .eq() lookups — never string-interpolate a client value
    // into a PostgREST filter expression — and sign the DB-sourced column,
    // same as the attachment branch above.
    const { data: revByFile } = await supabase
      .from("submittal_revisions")
      .select("storage_path")
      .eq("submittal_id", id)
      .eq("storage_path", requestedPath)
      .maybeSingle()
    if (revByFile?.storage_path) {
      return (await signedRedirect(revByFile.storage_path)) ?? storageDown()
    }

    const { data: revByCover } = await supabase
      .from("submittal_revisions")
      .select("cover_pdf_path")
      .eq("submittal_id", id)
      .eq("cover_pdf_path", requestedPath)
      .maybeSingle()
    if (revByCover?.cover_pdf_path) {
      return (await signedRedirect(revByCover.cover_pdf_path)) ?? storageDown()
    }

    return NextResponse.json({ error: "attachment not found" }, { status: 404 })
  }

  if (!submittal.storage_path) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  const originalPath = submittal.storage_path

  // ── Library stripped view (?stripped=1): serve the PRE-STRIPPED stored
  //    copy if one exists, else the original. Never strips on the fly.
  if (stripped) {
    if (submittal.stripped_storage_path) {
      const r = await signedRedirect(submittal.stripped_storage_path)
      if (r) return r
      // Stripped object missing/unreachable → fall back to the original.
    }
    return (await signedRedirect(originalPath)) ?? storageDown()
  }

  // ── Default download (no params). Non-PDF → original.
  if (submittal.mime_type !== "application/pdf") {
    return (await signedRedirect(originalPath)) ?? storageDown()
  }

  // PDF default: prepend the company cover sheet when configured. Wrapped so
  // ANY failure (download error, malformed/huge PDF, pdf-lib throw) falls
  // back to the raw original — a bad PDF must never 500 a download.
  try {
    const { data: settings } = await supabase
      .from("company_settings")
      .select("cover_page_path")
      .maybeSingle()

    if (!settings?.cover_page_path) {
      return (await signedRedirect(originalPath)) ?? storageDown()
    }

    const [{ data: submittalBlob, error: e1 }, { data: coverBlob, error: e2 }] = await Promise.all([
      supabase.storage.from("submittals").download(originalPath),
      supabase.storage.from("company-assets").download(settings.cover_page_path),
    ])
    if (!submittalBlob || !coverBlob || e1 || e2) throw new Error("cover/submittal download failed")

    const [submittalBytes, coverBytes] = await Promise.all([
      submittalBlob.arrayBuffer(),
      coverBlob.arrayBuffer(),
    ])
    const coverDoc     = await PDFDocument.load(coverBytes)
    const submittalDoc = await PDFDocument.load(submittalBytes)
    const mergedDoc    = await PDFDocument.create()
    const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
    coverPages.forEach(p => mergedDoc.addPage(p))
    const submittalPages = await mergedDoc.copyPages(submittalDoc, submittalDoc.getPageIndices())
    submittalPages.forEach(p => mergedDoc.addPage(p))
    const mergedBytes = await mergedDoc.save()

    return new NextResponse(Buffer.from(mergedBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${submittal.file_name}"`,
      },
    })
  } catch (err) {
    console.warn("[download] cover-merge failed, serving original", err)
    return (await signedRedirect(originalPath)) ?? storageDown()
  }
}
