import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { extractPdfPages } from "@/lib/spec-parser"
import { analyzePdf } from "@/lib/bulk-import-detect"
import { extractRawFormFields, recoverCoversheetFields, extractApprovalStampDate } from "@/lib/bulk-import-form"
import { hashBufferInNode } from "@/lib/file-hash-node"

// Bulk Import — Stage 1 analyze. Read-only by design: this route NEVER
// writes to the submittals table, NEVER mutates the staged PDF, and never
// strips coversheet pages. It only reads the staged file, extracts text per
// page, and returns the three suggestions (section + type + coversheet split)
// for human confirm in the review table.
//
// The PDF must already be in storage at `storage_path` (staged via the
// /api/storage/presigned-url flow — the client uploaded it to
// `{company_id}/bulk-import-staging/...` before calling this route). We
// verify the path is tenant-scoped to the caller's company before reading.
// Stage 2 will be responsible for committing the suggestions (or their
// human-edited versions) and for cleaning up staged objects.

// Longer than the default — extracting text from a 50-page signed submittal
// can take several seconds; matches the spec-book parse ceiling pattern.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const storagePath: string = typeof body?.storage_path === "string" ? body.storage_path.trim() : ""
  const fileName:    string = typeof body?.file_name    === "string" ? body.file_name.trim()    : ""

  if (!storagePath) return NextResponse.json({ error: "storage_path is required" }, { status: 400 })
  if (!fileName)    return NextResponse.json({ error: "file_name is required" }, { status: 400 })

  // Defense-in-depth on the storage RLS: the path must start with the
  // caller's company_id segment. Storage RLS would block a cross-tenant
  // signed-URL download anyway, but failing fast here keeps us from spending
  // a function invocation on something we won't be allowed to read.
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  if (!storagePath.startsWith(`${companyId}/`)) {
    return NextResponse.json({ error: "storage_path is outside this company" }, { status: 400 })
  }
  // Stage 1 is opinionated about staging directory — anything written by the
  // bulk-import client should land under `<company_id>/bulk-import-staging/`.
  // Reject paths that wandered elsewhere.
  if (!storagePath.startsWith(`${companyId}/bulk-import-staging/`)) {
    return NextResponse.json({ error: "storage_path must be inside bulk-import-staging/" }, { status: 400 })
  }

  // ── Read the staged PDF and extract per-page text ────────────────────────
  const { data: blob, error: dlErr } = await supabase.storage
    .from("submittals")
    .download(storagePath)
  if (dlErr || !blob) {
    return NextResponse.json({ error: dlErr?.message ?? "Could not read staged file" }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())

  let pages: string[]
  try {
    pages = await extractPdfPages(buffer)
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Could not parse PDF",
      // Surface this as a row-level error in the review table.
      stage: "extract",
    }, { status: 422 })
  }

  // ── Recover the coversheet's AcroForm widget values ─────────────────────
  // THP submitter coversheets are fillable PDF forms. The static labels
  // ("Spec Section No.", "Date Submitted", …) are in the text stream and
  // already extracted above, but the user-typed VALUES live in form-widget
  // annotations that text extractors don't see. extractRawFormFields uses
  // pdf-lib to enumerate the widgets and recover those values. The detector
  // treats this as the authoritative section source (it's what the human
  // typed on the coversheet).
  //
  // STAGE 2 ORDERING — when the commit/strip route is built, this read
  // MUST happen BEFORE any coversheet pages are stripped. Strip the cover,
  // and both the widget tree and the labeled text vanish with it.
  const rawFormFields = await extractRawFormFields(buffer)
  const recovery = recoverCoversheetFields(rawFormFields)

  // ── Architect-stamp date (THE approval date) ────────────────────────────
  // Waters coversheets have one date field (Text4 = GC's "Date Submitted")
  // and an architect stamp on the disposition-stamp page. The stamp is a
  // PDF /Stamp annotation whose /CreationDate is set when the architect
  // applies it — that IS the approval date. extractApprovalStampDate scans
  // the first 6 pages for /Stamp annotations and returns the earliest one.
  // Returns null on no stamp; the analyzer flags approval-empty rather
  // than falling back to Text4 (which is the SUBMISSION date, not approval).
  const approvalStamp = await extractApprovalStampDate(buffer)

  // ── Pure detection — no I/O from here on. ───────────────────────────────
  // Section detection is template-agnostic: analyzePdf runs the generic CSI
  // extractor against rawFormFields + coversheet-page text. The recovery
  // struct supplies nice-to-haves only (submitter, title, submittal#, date).
  const analysis = analyzePdf(fileName, pages, rawFormFields, recovery, approvalStamp)

  // ── SHA-256 for exact-duplicate detection (Part C). Computed here
  // because the buffer is already in memory for text extraction; adding
  // a hash pass costs ~50 ms even on a 30-page PDF. The hash is returned
  // alongside the analysis so the client can call /api/check-duplicate
  // BEFORE the user commits, and so the commit route can pass it to the
  // attachment RPC.
  const fileSha256 = await hashBufferInNode(buffer)

  return NextResponse.json({
    storage_path: storagePath,
    file_name: fileName,
    file_sha256: fileSha256,
    analysis,
  })
}
