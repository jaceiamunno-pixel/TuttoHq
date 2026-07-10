import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/bulk-import/log-rows?project_id=…&q=…
//
// Returns the available spec-built submittals rows for a project so the
// Stage 2a "no-match" UI can let the user pick a different log row to
// attach an unmatched Bulk Import file to.
//
// Read-only. RLS scopes by company. Only spec-built, non-deleted,
// not-yet-attached rows are returned (filtered by storage_path IS NULL)
// — those are the rows the commit route will accept.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = (searchParams.get("project_id") ?? "").trim()
  const q = (searchParams.get("q") ?? "").trim()
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "200", 10) || 200, 500)

  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  // Confirm project belongs to the caller's company (RLS already enforces
  // this on SELECT; this short-circuits with a clean error).
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single()
  if (pErr || !project) {
    return NextResponse.json({ error: "project not found or not accessible" }, { status: 404 })
  }

  let query = supabase
    .from("submittals")
    .select("id, csi_section, submittal_type, submittal_seq, section_seq, material_name, spec_section_id, csi_division, division_name")
    .eq("project_id", projectId)
    .eq("source", "spec_ingestion")
    .neq("status", "deleted")
    .is("storage_path", null)
    .order("csi_section", { ascending: true })
    .order("submittal_seq", { ascending: true })
    .limit(limit)

  // Optional search: section number prefix or material_name substring.
  if (q) {
    const safe = q.replace(/[%_]/g, "")  // strip ilike wildcards
    query = query.or(
      `csi_section.ilike.%${safe}%,material_name.ilike.%${safe}%,submittal_type.ilike.%${safe}%`,
    )
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ project_id: projectId, rows: data ?? [] })
}
