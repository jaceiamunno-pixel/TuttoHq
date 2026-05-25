import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()
  const allowed = ["status", "title", "assigned_to", "due_date", "notes", "file_url", "file_name", "linked_record_id", "linked_record_type"]
  const safe: Record<string, unknown> = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  if (safe.status === "complete") {
    safe.completed_at = new Date().toISOString()
    safe.completed_by = user.id
  } else if (safe.status && safe.status !== "complete") {
    safe.completed_at = null
    safe.completed_by = null
  }

  const { data: row, error: selErr } = await supabase
    .from("closeout_items").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("closeout_items").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("closeout_items").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("closeout_items").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
