import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("daily_reports").select("*").order("report_date", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reports: data ?? [] })
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
      fileBytes = await f.arrayBuffer()
      fileType = f.type || "application/octet-stream"
      origFileName = f.name
    }
  } else {
    fields = await req.json()
  }

  const {
    report_date, project_id, prepared_by,
    weather_conditions, temperature, manpower_count,
    work_performed, equipment, materials_delivered,
    visitors, issues_delays, safety_notes,
  } = fields

  if (!report_date) return NextResponse.json({ error: "report_date is required" }, { status: 400 })

  const { data: profile } = await supabase.from("user_profiles").select("company_id").maybeSingle()
  const company_id = profile?.company_id ?? null

  let file_path: string | null = null
  let file_name: string | null = null
  if (fileBytes && origFileName) {
    const safeName = origFileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    file_path = `daily-reports/${Date.now()}_${safeName}`
    file_name = origFileName
    await supabase.storage.from("submittals").upload(file_path, fileBytes, { contentType: fileType, upsert: false })
  }

  const { data, error } = await supabase.from("daily_reports").insert({
    report_date,
    project_id: project_id || null,
    prepared_by: prepared_by?.trim() || null,
    weather_conditions: weather_conditions?.trim() || null,
    temperature: temperature?.trim() || null,
    manpower_count: manpower_count ? parseInt(manpower_count) : null,
    work_performed: work_performed?.trim() || null,
    equipment: equipment?.trim() || null,
    materials_delivered: materials_delivered?.trim() || null,
    visitors: visitors?.trim() || null,
    issues_delays: issues_delays?.trim() || null,
    safety_notes: safety_notes?.trim() || null,
    file_path,
    file_name,
    company_id,
    uploaded_by: user.id,
  }).select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id: data?.[0]?.id, ok: true })
}
