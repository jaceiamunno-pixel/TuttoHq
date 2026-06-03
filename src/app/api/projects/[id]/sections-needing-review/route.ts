import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/projects/[id]/sections-needing-review
//
// Returns a compact set of spec_section_id values for the project where
// the parser fell back to the MasterFormat division name as a last
// resort. The Library log uses this to badge submittal rows pointing at
// those spec sections ("title needs review" indicator).
//
// Read-only. RLS scopes by company via the spec_sections.project_id link
// to projects.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params
  if (!projectId) return NextResponse.json({ error: "project id required" }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("spec_sections")
    .select("id")
    .eq("project_id", projectId)
    .eq("needs_title_review", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    project_id: projectId,
    spec_section_ids: (data ?? []).map(r => r.id),
  })
}
