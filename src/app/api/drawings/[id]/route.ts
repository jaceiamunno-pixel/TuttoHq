import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = ["sheet_title", "discipline", "revision_date", "status", "scale", "notes", "project_id"]
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  const { error } = await supabase.from("drawing_log").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // RLS-gated lookup: only returns the row if it belongs to the user's company.
  const { data: dwg, error: selErr } = await supabase
    .from("drawing_log").select("id, drawing_number, project_id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!dwg) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Bulk delete by drawing_number is bounded to this company by the RLS DELETE
  // policy on drawing_log — the user client cannot reach other companies' rows.
  // It must ALSO be bounded to this drawing's project: sheet numbers repeat across
  // projects, so an unbounded delete would wipe same-numbered drawings company-wide.
  // project_id is nullable (shelf drawings) and PostgREST .eq() never matches NULL,
  // so use .is("project_id", null) for the shelf case.
  if (dwg.drawing_number) {
    let del = supabase.from("drawing_log").delete().eq("drawing_number", dwg.drawing_number)
    del = dwg.project_id == null ? del.is("project_id", null) : del.eq("project_id", dwg.project_id)
    await del
  } else {
    await supabase.from("drawing_log").delete().eq("id", id)
  }
  return NextResponse.json({ ok: true })
}
