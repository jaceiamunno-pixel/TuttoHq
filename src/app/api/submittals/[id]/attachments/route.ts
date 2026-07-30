import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"

// Downloading + hashing a large revision PDF can take a while (storage cap is
// 50 MB project-wide) — give POST the same headroom the other file routes get.
export const maxDuration = 60

// GET /api/submittals/[id]/attachments
//
// Returns every revision attached to a submittal log row, newest first.
// Used by the Library view's revision history slide-out. Read-only.
// RLS scopes by company on submittal_attachments via the denormalized
// company_id column; the route additionally verifies the parent submittal
// is accessible to the caller for a clean 404 vs. empty array.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: submittalId } = await params
  if (!submittalId) {
    return NextResponse.json({ error: "submittal id required" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  // Confirm the parent submittal is accessible (RLS-filtered) — returns
  // 404 rather than an empty array when the row is in a different company.
  const { data: parent, error: pErr } = await supabase
    .from("submittals")
    .select("id, company_id, project_id, csi_section, submittal_type, material_name")
    .eq("id", submittalId)
    .single()
  if (pErr || !parent) {
    return NextResponse.json({ error: "submittal not found or not accessible" }, { status: 404 })
  }

  const { data, error } = await supabase
    .from("submittal_attachments")
    .select("id, storage_path, file_name, file_size, mime_type, revision_label, is_current, approval_date, review_status, submittal_number, uploaded_at, source")
    .eq("submittal_id", submittalId)
    .order("uploaded_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    submittal: {
      id: parent.id,
      csi_section: parent.csi_section,
      submittal_type: parent.submittal_type,
      material_name: parent.material_name,
    },
    attachments: data ?? [],
  })
}

// POST /api/submittals/[id]/attachments — attach a new REVISION to a row that
// already has a document (the log's per-row "Upload Rev" button).
//
// The file bytes never transit this route: the browser PUTs them to storage via
// /api/storage/presigned-url (prefix "uploads" → {company_id}/uploads/{uuid}_name,
// the same canonical home bulk-import promotes into), then sends the stored
// path here. This route re-downloads the object server-side to compute
// file_sha256 itself — the RPC's same-bytes idempotency guard is only as
// trustworthy as the hash, so it is never taken from the client — and measures
// p_file_size from the actual bytes for the same reason.
//
// All attach semantics live in the add_submittal_attachment RPC and its sync
// trigger; this route deliberately re-implements NONE of them:
//   - tenant + ownership: RPC checks get_my_company_id() and raises
//     'submittal not found or not accessible' (we also pre-check for a clean
//     404 and to read the parent's synced fields).
//   - one-current: DB partial unique index; newest-wins tiebreak in the RPC
//     (parsed revision number, then approval_date).
//   - same-bytes no-op: RPC returns the EXISTING row when (submittal_id,
//     sha256, revision_label) matches; detected here by storage_path mismatch
//     (the just-uploaded object is then an orphan and is removed).
//
// Trigger-synced parent columns — what we pass and why (the trigger copies
// these onto the parent when the new attachment becomes current):
//   - p_review_status  = parent's CURRENT review_status → the trigger writes
//     back the value the parent already has. Deliberate no-op: the
//     review-status vocabulary rewrite owns that column; this route must not
//     change it. Status-on-revision-upload is a follow-up behind that work.
//   - p_submittal_number = parent's current submittal_number — straight
//     assignment in the trigger, so passing null would erase it.
//   - p_approval_date  = null → parent returned_from_ae_date resets. This is
//     the DESIGNED revision lifecycle (0037a: "a new revision is not yet
//     approved"); the prior revision keeps its own approval_date on its row.
//   - p_submitted_date = null → sent_to_ae_date is COALESCE-guarded (0037a),
//     so the stamped send date survives.
//
// A revision ADDS an attachment row. Nothing here deletes or overwrites a
// prior attachment or its object; the only object this route ever removes is
// the one uploaded by THIS request, and only when the DB declined to reference
// it (duplicate no-op / RPC failure).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: submittalId } = await params
  if (!submittalId) {
    return NextResponse.json({ error: "submittal id required" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const storagePath   = typeof body.storage_path === "string" ? body.storage_path.trim() : ""
  const fileName      = typeof body.file_name === "string" ? body.file_name.trim() : ""
  const revisionLabel = typeof body.revision_label === "string" ? body.revision_label.trim() : ""

  if (!storagePath || !fileName) {
    return NextResponse.json({ error: "storage_path and file_name are required" }, { status: 400 })
  }
  if (!revisionLabel || revisionLabel.length > 24) {
    return NextResponse.json({ error: "revision_label is required (24 characters max)" }, { status: 400 })
  }

  // Tenant isolation on the object path — company_id comes from the caller's
  // session, never from the client. The uploaded object must sit in THIS
  // company's canonical uploads/ directory (the presign route builds exactly
  // this shape; anything else is a crafted path).
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }
  if (storagePath.includes("..") || !storagePath.startsWith(`${companyId}/uploads/`)) {
    return NextResponse.json({ error: "storage_path must be inside this company's uploads directory" }, { status: 400 })
  }

  // Parent pre-check (RLS-scoped). 404 copy matches the GET and the RPC's own
  // error text. Also the source of the trigger-synced values passed back below.
  const { data: parent, error: pErr } = await supabase
    .from("submittals")
    .select("id, storage_path, review_status, submittal_number, revision_number")
    .eq("id", submittalId)
    .single()
  if (pErr || !parent) {
    return NextResponse.json({ error: "submittal not found or not accessible" }, { status: 404 })
  }
  if (parent.storage_path == null) {
    return NextResponse.json(
      { error: "This submittal has no document yet — add its first document through the regular upload flow; Upload Revision is for rows that already have one." },
      { status: 409 },
    )
  }

  // Server-side hash + size of the ACTUAL stored bytes (storage RLS re-checks
  // tenant access on this download). A missing object means the browser PUT
  // never landed — fail before touching the database.
  const { data: blob, error: dlErr } = await supabase.storage.from("submittals").download(storagePath)
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: "Uploaded file not found in storage — the upload may have failed; try again." },
      { status: 400 },
    )
  }
  const bytes = Buffer.from(await blob.arrayBuffer())
  const fileSha256 = createHash("sha256").update(bytes).digest("hex")
  const fileSize = bytes.byteLength

  const { data: attachment, error: rpcErr } = await supabase.rpc("add_submittal_attachment", {
    p_submittal_id:     submittalId,
    p_storage_path:     storagePath,
    p_file_name:        fileName,
    p_file_size:        fileSize,
    p_revision_label:   revisionLabel,
    p_approval_date:    null,
    p_review_status:    parent.review_status ?? null,
    p_submittal_number: parent.submittal_number ?? null,
    p_source:           "revision_upload",
    p_submitted_date:   null,
    p_file_sha256:      fileSha256,
  }).single()

  if (rpcErr || !attachment) {
    // The object we just verified is now unreferenced — best-effort cleanup so
    // a failed attach doesn't leave an orphan in uploads/.
    await supabase.storage.from("submittals").remove([storagePath]).catch(() => {})
    const notAccessible = rpcErr?.message?.includes("submittal not found or not accessible")
    return NextResponse.json(
      { error: notAccessible ? "submittal not found or not accessible" : `Could not attach the revision: ${rpcErr?.message ?? "RPC returned no row"}` },
      { status: notAccessible ? 404 : 500 },
    )
  }

  const att = attachment as { id: string; storage_path: string; is_current: boolean; revision_label: string }

  // Same-bytes idempotency no-op — the RPC returned a PRE-EXISTING row (same
  // submittal + same sha256 + same label), so nothing new was recorded and the
  // object this request uploaded is an orphan. Remove it and say so plainly:
  // this must not read as a fresh upload.
  if (att.storage_path !== storagePath) {
    const { error: orphanErr } = await supabase.storage.from("submittals").remove([storagePath])
    if (orphanErr) {
      console.warn("[submittal-revision] orphan uploads cleanup failed for", storagePath, orphanErr.message)
    }
    return NextResponse.json({
      ok: true,
      outcome: "duplicate",
      attachment: att,
      message: `This exact file is already on file as ${att.revision_label} — nothing new was added.`,
    })
  }

  // New row inserted. Surface is_current honestly — a losing insert (older or
  // equal revision number than the one on file) is legal and KEPT, but the log
  // row still shows the existing current document, and the user must hear that
  // from us, not discover it later.
  if (att.is_current) {
    return NextResponse.json({
      ok: true,
      outcome: "current",
      attachment: att,
      message: `Rev ${att.revision_label} uploaded — it is now the current document on this submittal.`,
    }, { status: 201 })
  }

  const { data: cur } = await supabase
    .from("submittal_attachments")
    .select("revision_label")
    .eq("submittal_id", submittalId)
    .eq("is_current", true)
    .maybeSingle()
  const currentLabel = cur?.revision_label ?? parent.revision_number ?? "the existing revision"
  return NextResponse.json({
    ok: true,
    outcome: "superseded",
    attachment: att,
    message: `Rev ${att.revision_label} was added to the revision history, but it did not become the current document — ${currentLabel} on file is newer. The log row still shows ${currentLabel}.`,
  }, { status: 201 })
}
