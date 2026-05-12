import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("rfis")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rfis: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const { subject, description, submitted_by, assigned_to, date_issued, due_date, project_id } = body

  if (!subject?.trim()) return NextResponse.json({ error: "subject is required" }, { status: 400 })

  // Auto-generate RFI number from count of existing RFIs
  const { count } = await supabase.from("rfis").select("*", { count: "exact", head: true })
  const rfi_number = `RFI-${String((count ?? 0) + 1).padStart(3, "0")}`

  const { error } = await supabase.from("rfis").insert({
    rfi_number,
    subject: subject.trim(),
    description: description?.trim() || null,
    submitted_by: submitted_by?.trim() || null,
    assigned_to: assigned_to?.trim() || null,
    date_issued: date_issued || null,
    due_date: due_date || null,
    project_id: project_id || null,
    status: "Open",
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, rfi_number })
}
