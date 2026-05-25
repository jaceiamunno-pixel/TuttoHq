import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const body = await req.json()

  const { name, number, location, gc_name, architect } = body

  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
  }

  const updates: Record<string, string | null> = {}
  if (name !== undefined) updates.name = name.trim()
  if (number !== undefined) updates.number = number?.trim() ?? null
  if (location !== undefined) updates.location = location?.trim() ?? null
  if (gc_name !== undefined) updates.gc_name = gc_name?.trim() ?? null
  if (architect !== undefined) updates.architect = architect?.trim() ?? null

  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", id)
    .select("id, name, number, location, gc_name, architect, created_at")
    .single()

  if (error) {
    console.error("Failed to update project:", error)
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 })
  }

  return NextResponse.json({ project: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // RLS-gated ownership check before the cascade.
  const { data: project, error: selErr } = await supabase
    .from("projects").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Delete child records first to avoid FK constraint violations. RLS DELETE
  // policies on every child table scope by company, so the user client only
  // touches rows in the requester's company.
  await Promise.all([
    supabase.from("submittals").delete().eq("project_id", id),
    supabase.from("rfis").delete().eq("project_id", id),
    supabase.from("change_orders").delete().eq("project_id", id),
    supabase.from("punch_items").delete().eq("project_id", id),
    supabase.from("drawing_log").delete().eq("project_id", id),
    supabase.from("daily_reports").delete().eq("project_id", id),
    supabase.from("closeout_items").delete().eq("project_id", id),
    supabase.from("team_members").delete().eq("project_id", id),
  ])

  const { error } = await supabase.from("projects").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
