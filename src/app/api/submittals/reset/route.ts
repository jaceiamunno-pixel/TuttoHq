import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Reset Submittal Log — hard-deletes submittals for a project.
//  - scope = "all":            every submittal in the project
//  - scope = "spec_ingestion": only AI-staged rows (source = 'spec_ingestion'),
//                              leaving manual + Gmail-intake rows intact
//
// GET  ?project_id=&scope=   → { count }   (preview count for the confirm modal)
// POST { project_id, scope } → { deleted }

type Scope = "all" | "spec_ingestion"

function parseScope(raw: unknown): Scope | null {
  return raw === "all" || raw === "spec_ingestion" ? raw : null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get("project_id")
  const scope = parseScope(searchParams.get("scope"))
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!scope)     return NextResponse.json({ error: "scope must be 'all' or 'spec_ingestion'" }, { status: 400 })

  let q = supabase
    .from("submittals")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
  if (scope === "spec_ingestion") q = q.eq("source", "spec_ingestion")

  const { count, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ count: count ?? 0 })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const projectId: unknown = body?.project_id
  const scope = parseScope(body?.scope)
  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  }
  if (!scope) return NextResponse.json({ error: "scope must be 'all' or 'spec_ingestion'" }, { status: 400 })

  // Hard delete (not the usual soft-delete) — Reset is explicitly irreversible.
  // RLS keeps this scoped to the caller's company.
  let q = supabase
    .from("submittals")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
  if (scope === "spec_ingestion") q = q.eq("source", "spec_ingestion")

  const { count, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // A full reset restarts numbering at 1; a spec-only reset leaves the counter
  // (and the manual rows' existing numbers) untouched.
  if (scope === "all") {
    await supabase
      .from("project_submittal_counters")
      .update({ last_seq: 0 })
      .eq("project_id", projectId)
  }

  return NextResponse.json({ deleted: count ?? 0 })
}
