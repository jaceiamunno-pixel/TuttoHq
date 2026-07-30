import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"

const MAX_BYTES = 50 * 1024 * 1024 // 50 MB

// POST /api/spec-books/presigned-url — issues a Supabase Storage signed upload
// URL so the browser can send the spec book PDF straight to storage, bypassing
// Vercel's 4.5 MB serverless function body limit.
//
// The `project_documents` row is inserted up front (parse_status 'pending') so
// the storage path can embed its id. POST /api/spec-books/finalize then
// confirms the upload landed and records the real byte size.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // ADR-020: spec books are a submittals-surface capability. A field session
  // can pass the project-visibility check below (granted projects ARE
  // visible), so deny explicitly before minting any upload URL.
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const body = await req.json().catch(() => null)
  const projectId = typeof body?.project_id === "string" ? body.project_id.trim() : ""
  const fileName  = typeof body?.file_name === "string" ? body.file_name.trim() : ""
  const fileSize  = typeof body?.file_size === "number" ? body.file_size : NaN

  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!fileName)  return NextResponse.json({ error: "file_name is required" }, { status: 400 })
  if (!fileName.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF files are supported" }, { status: 400 })
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: "A valid file_size is required" }, { status: 400 })
  }
  if (fileSize > MAX_BYTES) {
    return NextResponse.json({ error: "File exceeds the 50 MB limit" }, { status: 400 })
  }

  // Confirm the user can see this project — RLS scopes the row to their company.
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 403 })
  }

  // Tenant-isolated path: {company_id}/... prefix is what the new storage.objects
  // RLS policies will check via (storage.foldername(name))[1].
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }

  // Pre-generate the id so the storage path can embed it. file_path is NOT NULL,
  // so the row cannot be inserted without it — generating the id here avoids an
  // insert-then-update round trip.
  const documentId = randomUUID()
  const safeName    = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const filePath    = `${companyId}/spec-books/${documentId}/${safeName}`

  const { data: signed, error: signError } = await supabase.storage
    .from("submittals")
    .createSignedUploadUrl(filePath, { upsert: true })
  if (signError || !signed) {
    return NextResponse.json(
      { error: signError?.message ?? "Could not create an upload URL" },
      { status: 500 },
    )
  }

  // file_size_bytes is left null here; finalize sets it from the real stored
  // object. A 'pending' row with file_size_bytes IS NULL is also how an
  // abandoned upload (tab closed mid-PUT) can be identified for later cleanup.
  const { error: dbError } = await supabase
    .from("project_documents")
    .insert({
      id:           documentId,
      project_id:   projectId,
      type:         "spec_book",
      file_path:    filePath,
      file_name:    fileName,
      parse_status: "pending",
      uploaded_by:  user.id,
    })

  if (dbError) {
    return NextResponse.json(
      { error: dbError.message ?? "Failed to create the document record" },
      { status: 500 },
    )
  }

  return NextResponse.json(
    { document_id: documentId, file_path: filePath, signed_url: signed.signedUrl },
    { status: 201 },
  )
}
