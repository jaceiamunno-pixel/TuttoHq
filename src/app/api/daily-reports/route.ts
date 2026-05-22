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

  // The attachment (if any) was already PUT straight to storage from the
  // browser via a signed upload URL, so this route receives only JSON metadata.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))

  const {
    report_date, project_id, prepared_by,
    weather_conditions, temperature, manpower_count,
    work_performed, equipment, materials_delivered,
    visitors, issues_delays, safety_notes,
  } = fields

  if (!report_date) return NextResponse.json({ error: "report_date is required" }, { status: 400 })

  const { data: profile } = await supabase.from("user_profiles").select("company_id").maybeSingle()
  const company_id = profile?.company_id ?? null

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

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
