import { NextRequest, NextResponse } from "next/server"
import { createClientFromRequest } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClientFromRequest(req)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get("project_id")

  // Revisions (submittal_revisions — nested cover-sheet issues, migration
  // 0055) ride along as an EMBEDDED resource: one PostgREST request for the
  // whole result set, never an N+1 per row and never an `.in(ids)` whose URL
  // blows up on a 1200-row log. RLS company-scopes the child rows the same
  // as the parents.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from("submittals")
    .select("*, revisions:submittal_revisions(*)")
    .eq("status", "active")
    .order("created_at", { ascending: false })

  if (projectId) query = query.eq("project_id", projectId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Newest revision first — [0] is the log's status roll-up. Sorted here
  // rather than via an embedded-order param so the contract is explicit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const submittals = (data ?? []).map((s: any) => ({
    ...s,
    revisions: (s.revisions ?? []).sort(
      (a: { rev_seq: number }, b: { rev_seq: number }) => b.rev_seq - a.rev_seq,
    ),
  }))

  return NextResponse.json({ submittals })
}
