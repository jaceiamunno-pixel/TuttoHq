import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/staged-submittals?project_id=X — the project's uncommitted staged
// submittals, gated to the project's scope, plus the spec sections they belong
// to. Backs the Submittals → Pending Review view.
//
// Scope gate: mirrors /api/staged-submittals/commit (PR #58) so Pending Review
// shows exactly what a commit would write. Only rows whose section is in_scope per
// project_scope_sections are returned (joined on spec_number — the reparse-stable
// key; a re-parse rotates spec_section_id but spec_number survives). The scope list
// is read here under the caller's company RLS — never client-supplied.
//
// LEGACY (DO NOT BREAK): a project with ZERO project_scope_sections rows is "not
// yet scoped" and returns ALL uncommitted rows — identical fallback to the commit
// route. `hiddenCount` reports how many rows were withheld as out-of-scope so the
// UI can note them without re-fetching the unfiltered set.
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

  const allRows = staged ?? []

  // Scope gate — same logic as the commit route (PR #58).
  const { data: scopeRows } = await supabase
    .from("project_scope_sections")
    .select("spec_number, in_scope")
    .eq("project_id", projectId)
  const hasScope = (scopeRows ?? []).length > 0
  const inScope = new Set(
    (scopeRows ?? []).filter(r => r.in_scope).map(r => r.spec_number as string),
  )
  const rows = hasScope ? allRows.filter(r => inScope.has(r.spec_number)) : allRows
  const hiddenCount = allRows.length - rows.length

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

  return NextResponse.json({ staged: rows, sections, documents: documents ?? [], hiddenCount })
}
