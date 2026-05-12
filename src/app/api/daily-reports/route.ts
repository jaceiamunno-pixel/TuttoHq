import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("daily_reports")
    .select("*")
    .order("report_date", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reports: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const {
    report_date, project_id, prepared_by,
    weather_conditions, temperature, manpower_count,
    work_performed, equipment, materials_delivered,
    visitors, issues_delays, safety_notes,
  } = body

  if (!report_date) return NextResponse.json({ error: "report_date is required" }, { status: 400 })

  const { error } = await supabase.from("daily_reports").insert({
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
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
