import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("punch_items")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const { description, location, assigned_to, due_date, priority, project_id, notes } = body

  if (!description?.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 })

  const { count } = await supabase.from("punch_items").select("*", { count: "exact", head: true })
  const item_number = `P-${String((count ?? 0) + 1).padStart(3, "0")}`

  const { error } = await supabase.from("punch_items").insert({
    item_number,
    description: description.trim(),
    location: location?.trim() || null,
    assigned_to: assigned_to?.trim() || null,
    due_date: due_date || null,
    priority: priority || "Medium",
    status: "Open",
    notes: notes?.trim() || null,
    project_id: project_id || null,
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, item_number })
}
