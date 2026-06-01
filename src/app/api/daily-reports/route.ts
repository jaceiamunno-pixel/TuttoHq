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

// Accepts an optional `client_id` (UUID) that becomes the inserted row's id.
// This makes the route idempotent end-to-end: the offline-first photo flow
// generates the report id on the client, tags its draft photos with it
// locally, then POSTs this route — possibly multiple times if a retry is
// needed. The upsert on id means a second POST with the same client_id
// returns the existing row instead of creating a duplicate.
//
// Falls back to the DB's gen_random_uuid() default when client_id is
// absent, preserving the legacy "create with server-generated id" flow.
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

  const client_id = typeof fields.client_id === "string" ? fields.client_id.trim() : ""
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const useClientId = UUID_RE.test(client_id)

  const insertData: Record<string, unknown> = {
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
  }
  if (useClientId) insertData.id = client_id

  const builder = useClientId
    ? supabase.from("daily_reports").upsert(insertData, { onConflict: "id" })
    : supabase.from("daily_reports").insert(insertData)
  const { data, error } = await builder.select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id: data?.[0]?.id, ok: true })
}
