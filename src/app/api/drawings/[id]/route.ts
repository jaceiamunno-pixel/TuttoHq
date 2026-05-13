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
  // Get the drawing_number so we can delete all revisions
  const { data: dwg } = await supabase.from("drawing_log").select("drawing_number").eq("id", id).maybeSingle()
  if (dwg?.drawing_number) {
    await supabase.from("drawing_log").delete().eq("drawing_number", dwg.drawing_number)
  } else {
    await supabase.from("drawing_log").delete().eq("id", id)
  }
  return NextResponse.json({ ok: true })
}
