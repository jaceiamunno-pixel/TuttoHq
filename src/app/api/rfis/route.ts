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

  // Support both JSON and multipart FormData
  let fields: Record<string, string | null> = {}
  let fileBytes: ArrayBuffer | null = null
  let fileType = ""
  let origFileName = ""

  const contentType = req.headers.get("content-type") ?? ""
  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData()
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") fields[k] = v || null
    }
    const f = fd.get("file") as File | null
    if (f && f.size > 0) {
      fileBytes   = await f.arrayBuffer()
      fileType    = f.type || "application/octet-stream"
      origFileName = f.name
    }
  } else {
    fields = await req.json()
  }

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

  // Upload attachment if present
  let file_path: string | null = null
  let file_name: string | null = null
  if (fileBytes && origFileName) {
    const safeName = origFileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    file_path = `rfis/${Date.now()}_${safeName}`
    file_name = origFileName
    await supabase.storage.from("submittals").upload(file_path, fileBytes, { contentType: fileType, upsert: false })
  }

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
