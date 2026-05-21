import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/staged-submittals?project_id=X — every uncommitted staged submittal
// for a project (across all of its spec books) plus the spec sections they
// belong to. Backs the Submittals → Pending Review view.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data: staged, error } = await supabase
    .from("staged_submittals")
    .select("*")
    .eq("project_id", projectId)
    .is("committed_at", null)
    .order("spec_number", { ascending: true })
    .order("letter", { ascending: true, nullsFirst: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = staged ?? []
  const sectionIds = [...new Set(rows.map(r => r.spec_section_id))]

  let sections: unknown[] = []
  if (sectionIds.length > 0) {
    const { data: secs } = await supabase
      .from("spec_sections")
      .select("id, spec_number, spec_title, start_page, end_page, has_submittals")
      .in("id", sectionIds)
    sections = secs ?? []
  }

  // The project's spec books, newest first — carries parse_summary so the
  // Pending Review empty state can explain why a parse produced no rows.
  const { data: documents } = await supabase
    .from("project_documents")
    .select("id, file_name, parse_status, parse_summary, uploaded_at")
    .eq("project_id", projectId)
    .eq("type", "spec_book")
    .order("uploaded_at", { ascending: false })

  return NextResponse.json({ staged: rows, sections, documents: documents ?? [] })
}
