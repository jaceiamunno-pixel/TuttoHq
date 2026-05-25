import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = ["status", "notes", "assigned_to", "due_date", "priority", "description", "location", "completed_at"]
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  // Auto-set completed_at when status is changed to Completed
  if (safe.status === "Completed" && !safe.completed_at) {
    safe.completed_at = new Date().toISOString()
  } else if (safe.status && safe.status !== "Completed") {
    safe.completed_at = null
  }

  const { error } = await supabase.from("punch_items").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("punch_items").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("punch_items").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
