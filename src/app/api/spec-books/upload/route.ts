import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const MAX_BYTES = 50 * 1024 * 1024 // 50 MB

// POST /api/spec-books/upload — multipart upload of a spec book PDF.
// Stores the file, inserts a `project_documents` row with parse_status 'pending'.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  const projectId = (formData.get("project_id") as string | null)?.trim() || null

  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 })
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  if (!isPdf) return NextResponse.json({ error: "Only PDF files are supported" }, { status: 400 })
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File exceeds the 50 MB limit" }, { status: 400 })
  }

  const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
  const storagePath = `spec-books/${projectId}/${Date.now()}_${safeName}`

  const bytes = await file.arrayBuffer()
  const { error: storageError } = await supabase.storage
    .from("submittals")
    .upload(storagePath, bytes, { contentType: "application/pdf", upsert: false })

  if (storageError) {
    return NextResponse.json({ error: `Storage upload failed: ${storageError.message}` }, { status: 500 })
  }

  const { data: row, error: dbError } = await supabase
    .from("project_documents")
    .insert({
      project_id:      projectId,
      type:            "spec_book",
      file_path:       storagePath,
      file_name:       file.name,
      file_size_bytes: file.size,
      parse_status:    "pending",
      uploaded_by:     user.id,
    })
    .select()
    .single()

  if (dbError || !row) {
    await supabase.storage.from("submittals").remove([storagePath])
    return NextResponse.json({ error: dbError?.message ?? "Failed to save document record" }, { status: 500 })
  }

  return NextResponse.json({ document: row }, { status: 201 })
}
