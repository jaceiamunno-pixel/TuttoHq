import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("rfis").select("*").order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rfis: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The attachment (if any) was already PUT straight to storage from the
  // browser via a signed upload URL, so this route receives only JSON metadata.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))

  const { subject, description, question, received_from, submitted_by,
          specification_section, location, schedule_impact, cost_impact,
          assigned_to, date_issued, due_date, project_id } = fields

  if (!subject?.trim()) return NextResponse.json({ error: "subject is required" }, { status: 400 })

  // Auto-generate RFI number: per-project if project_id given, otherwise global
  let rfi_number: string
  if (project_id) {
    const { count } = await supabase.from("rfis")
      .select("*", { count: "exact", head: true })
      .eq("project_id", project_id)
    rfi_number = `RFI-${String((count ?? 0) + 1).padStart(3, "0")}`
  } else {
    const { count } = await supabase.from("rfis").select("*", { count: "exact", head: true })
    rfi_number = `RFI-${String((count ?? 0) + 1).padStart(3, "0")}`
  }

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

  const { error } = await supabase.from("rfis").insert({
    rfi_number,
    subject:               subject.trim(),
    description:           (question ?? description)?.trim() || null,
    received_from:         received_from?.trim() || null,
    submitted_by:          (received_from ?? submitted_by)?.trim() || null,
    specification_section: specification_section?.trim() || null,
    location:              location?.trim() || null,
    schedule_impact:       schedule_impact || "TBD",
    cost_impact:           cost_impact || "TBD",
    assigned_to:           assigned_to?.trim() || null,
    date_issued:           date_issued || null,
    due_date:              due_date || null,
    project_id:            project_id || null,
    file_path,
    file_name,
    status:                "Open",
    uploaded_by:           user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, rfi_number })
}
