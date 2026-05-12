import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("change_orders")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ changeOrders: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

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
      fileBytes    = await f.arrayBuffer()
      fileType     = f.type || "application/octet-stream"
      origFileName = f.name
    }
  } else {
    fields = await req.json()
  }

  const { project_id, date, proposal, qualifications, pricing_sum,
          schedule_impact, schedule_impact_days, submitted_by, assigned_to, status } = fields

  if (!proposal?.trim() && !fields.co_number) {
    return NextResponse.json({ error: "proposal is required" }, { status: 400 })
  }

  // Auto-generate CO number per project
  let co_number: string
  if (project_id) {
    const { count } = await supabase.from("change_orders")
      .select("*", { count: "exact", head: true }).eq("project_id", project_id)
    co_number = fields.co_number?.trim() || `CO-${String((count ?? 0) + 1).padStart(3, "0")}`
  } else {
    const { count } = await supabase.from("change_orders").select("*", { count: "exact", head: true })
    co_number = fields.co_number?.trim() || `CO-${String((count ?? 0) + 1).padStart(3, "0")}`
  }

  // Upload attachment if present
  let file_path: string | null = null
  let file_name: string | null = null
  if (fileBytes && origFileName) {
    const safeName = origFileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    file_path = `change-orders/${Date.now()}_${safeName}`
    file_name = origFileName
    await supabase.storage.from("submittals").upload(file_path, fileBytes, { contentType: fileType, upsert: false })
  }

  const { error } = await supabase.from("change_orders").insert({
    co_number,
    project_id:           project_id || null,
    date:                 date || new Date().toISOString().slice(0, 10),
    proposal:             proposal?.trim() || null,
    qualifications:       qualifications?.trim() || null,
    pricing_sum:          pricing_sum ? parseFloat(pricing_sum) : null,
    schedule_impact:      schedule_impact || "TBD",
    schedule_impact_days: schedule_impact_days ? parseInt(schedule_impact_days) : null,
    file_path,
    file_name,
    status:               status || "Draft",
    submitted_by:         submitted_by?.trim() || null,
    assigned_to:          assigned_to?.trim() || null,
    uploaded_by:          user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, co_number })
}
