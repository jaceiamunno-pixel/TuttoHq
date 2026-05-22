import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("punch_items").select("*").order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The attachment (if any) was already PUT straight to storage from the
  // browser via a signed upload URL, so this route receives only JSON metadata.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))

  const { description, location, assigned_to, due_date, priority, project_id, notes } = fields
  if (!description?.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 })

  const { count } = await supabase.from("punch_items").select("*", { count: "exact", head: true })
  const item_number = `P-${String((count ?? 0) + 1).padStart(3, "0")}`

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

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
    file_path,
    file_name,
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, item_number })
}
