import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/spec-books/[documentId] — document + extracted sections + staged rows.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { documentId } = await params

  const { data: document, error } = await supabase
    .from("project_documents")
    .select("*")
    .eq("id", documentId)
    .single()
  if (error || !document) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: sections } = await supabase
    .from("spec_sections")
    .select("id, spec_number, spec_title, start_page, end_page, has_submittals")
    .eq("project_document_id", documentId)
    .order("spec_number", { ascending: true })

  const { data: staged } = await supabase
    .from("staged_submittals")
    .select("*")
    .eq("project_document_id", documentId)
    .order("spec_number", { ascending: true })
    .order("letter", { ascending: true, nullsFirst: true })

  return NextResponse.json({
    document,
    sections: sections ?? [],
    staged: staged ?? [],
  })
}

// DELETE /api/spec-books/[documentId] — removes the document, its stored PDF,
// and (via ON DELETE CASCADE) its spec_sections and staged_submittals.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { documentId } = await params

  const { data: row } = await supabase
    .from("project_documents")
    .select("file_path")
    .eq("id", documentId)
    .single()

  if (row?.file_path) {
    await supabase.storage.from("submittals").remove([row.file_path])
  }

  const { error } = await supabase.from("project_documents").delete().eq("id", documentId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
