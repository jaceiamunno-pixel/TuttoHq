import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, ownsProject } from "./_helpers"

// GET /api/takeoffs?project_id=…  → list takeoffs for a project (RLS scopes tenant).
export async function GET(req: NextRequest) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx

  const projectId = req.nextUrl.searchParams.get("project_id")
  if (!projectId) return badRequest("project_id is required")

  const { data, error } = await supabase
    .from("takeoffs")
    .select("id, project_id, name, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ takeoffs: data ?? [] })
}

// POST /api/takeoffs  { project_id, name }  → create a takeoff + seed one
// "Unassigned" room so a count click always lands somewhere.
export async function POST(req: NextRequest) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase, userId, companyId } = ctx

  const body = await req.json().catch(() => ({}))
  const projectId = typeof body.project_id === "string" ? body.project_id : null
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!projectId) return badRequest("project_id is required")
  if (!name) return badRequest("name is required")
  if (!(await ownsProject(supabase, projectId))) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  const { data: takeoff, error } = await supabase
    .from("takeoffs")
    .insert({ project_id: projectId, name, company_id: companyId, created_by: userId })
    .select("id, project_id, name, created_at")
    .single()
  if (error || !takeoff) {
    return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 })
  }

  // Seed the catch-all room (company_id set explicitly, same as every insert here).
  await supabase.from("takeoff_rooms").insert({
    takeoff_id: takeoff.id, company_id: companyId, name: "Unassigned", sort_order: 0,
  })

  return NextResponse.json({ takeoff })
}
