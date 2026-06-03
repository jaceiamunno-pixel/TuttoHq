import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/projects/[id]/attachment-counts
//
// Returns a compact map { submittal_id: attachment_count } for every
// submittal in the project that has at least 2 attachments (the threshold
// for showing the revision badge in the Library view).
//
// Read-only. RLS scopes by company via submittal_attachments.company_id.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params
  if (!projectId) return NextResponse.json({ error: "project id required" }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // RLS on submittals filters cross-tenant projects; SELECTing submittal_id
  // then aggregating in JS keeps the query simple and trustworthy.
  const { data, error } = await supabase
    .from("submittal_attachments")
    .select("submittal_id, submittals!inner(project_id)")
    .eq("submittals.project_id", projectId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const counts: Record<string, number> = {}
  for (const r of (data ?? []) as Array<{ submittal_id: string }>) {
    counts[r.submittal_id] = (counts[r.submittal_id] ?? 0) + 1
  }
  // Only return rows with >= 2 attachments (the badge threshold).
  const compact: Record<string, number> = {}
  for (const [k, v] of Object.entries(counts)) if (v >= 2) compact[k] = v

  return NextResponse.json({ project_id: projectId, counts: compact })
}
