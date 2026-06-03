import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { matchSubmittalRow, type MatchOutcome } from "@/lib/bulk-import-match"

// POST /api/bulk-import/match — given a list of reviewed Bulk Import rows
// (section + type + description), return the match outcome per row.
//
// Read-only. No writes. The commit route is separate; this exists so the
// modal can show match status immediately after Stage 1 analyze.
//
// Bounded: the per-row matcher is a single SQL query, no AI, no loops over
// candidates beyond the small candidate list. Capped at 100 rows per call
// (matches the modal's practical batch size) so a runaway payload can't
// stall the function.

interface RowIn {
  client_row_id: string
  section: string | null
  submittal_type: string | null
  description?: string | null
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const projectId: string = typeof body?.project_id === "string" ? body.project_id.trim() : ""
  const rows: RowIn[] = Array.isArray(body?.rows) ? body.rows : []

  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })
  if (rows.length === 0) return NextResponse.json({ error: "rows required" }, { status: 400 })
  if (rows.length > 100) return NextResponse.json({ error: "too many rows (max 100)" }, { status: 400 })

  // Defense-in-depth: confirm project belongs to the caller's company.
  // RLS already filters cross-company project rows on SELECT, so a project
  // pasted from another company yields a not-found response.
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, company_id")
    .eq("id", projectId)
    .single()
  if (pErr || !project) {
    return NextResponse.json({ error: "project not found or not accessible" }, { status: 404 })
  }

  const results: { client_row_id: string; outcome: MatchOutcome }[] = []
  for (const r of rows) {
    if (!r.client_row_id || typeof r.client_row_id !== "string") continue
    const outcome = await matchSubmittalRow(supabase, {
      project_id: projectId,
      section: r.section,
      submittal_type: r.submittal_type,
      description: r.description ?? null,
    })
    results.push({ client_row_id: r.client_row_id, outcome })
  }

  return NextResponse.json({ project_id: projectId, results })
}
