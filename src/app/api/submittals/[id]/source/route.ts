import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/submittals/[id]/source — resolves a spec-ingested submittal back to
// its source spec book PDF: a signed URL plus the section's start page, so the
// UI can open the PDF jumped to the right page (#page=N).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: submittal } = await supabase
    .from("submittals")
    .select("spec_section_id")
    .eq("id", id)
    .single()
  if (!submittal?.spec_section_id) {
    return NextResponse.json({ error: "This submittal has no source spec section." }, { status: 404 })
  }

  const { data: section } = await supabase
    .from("spec_sections")
    .select("start_page, spec_number, spec_title, project_document_id")
    .eq("id", submittal.spec_section_id)
    .single()
  if (!section?.project_document_id) {
    return NextResponse.json({ error: "Source spec section not found." }, { status: 404 })
  }

  const { data: doc } = await supabase
    .from("project_documents")
    .select("file_path, file_name")
    .eq("id", section.project_document_id)
    .single()
  if (!doc?.file_path) {
    return NextResponse.json({ error: "Source spec book file not found." }, { status: 404 })
  }

  const { data: signed, error: signErr } = await supabase
    .storage.from("submittals")
    .createSignedUrl(doc.file_path, 60 * 60) // 1 hour
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: signErr?.message ?? "Could not sign the source PDF URL." }, { status: 500 })
  }

  return NextResponse.json({
    url: signed.signedUrl,
    page: section.start_page ?? 1,
    spec_number: section.spec_number,
    spec_title: section.spec_title,
    file_name: doc.file_name,
  })
}
