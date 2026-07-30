import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"
import { parseCrew, crewHeadcount } from "@/lib/daily-crew"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("daily_reports").select("*").order("report_date", { ascending: false })
  if (pid) q = q.eq("project_id", pid)
  if (DAILY_0050_LIVE) q = q.is("deleted_at", null)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const reports = data ?? []

  // Photo-count badges for the list. Chunked so a large log never builds
  // an oversized IN clause.
  const photo_counts: Record<string, number> = {}
  const ids = reports.map(r => r.id as string)
  for (let i = 0; i < ids.length; i += 200) {
    const { data: ph } = await supabase
      .from("item_photos")
      .select("entity_id")
      .eq("entity_type", "daily_report")
      .in("entity_id", ids.slice(i, i + 200))
    for (const p of ph ?? []) {
      photo_counts[p.entity_id] = (photo_counts[p.entity_id] ?? 0) + 1
    }
  }

  // Names for submitted_by / updated_by attribution (0050 columns).
  const user_names: Record<string, string> = {}
  if (DAILY_0050_LIVE) {
    const uuids = [...new Set(reports.flatMap(r => [r.submitted_by, r.updated_by]).filter((v): v is string => !!v))]
    if (uuids.length) {
      const { data: profiles } = await supabase
        .from("user_profiles")
        .select("user_id, full_name")
        .in("user_id", uuids)
      for (const p of profiles ?? []) {
        if (p.full_name) user_names[p.user_id] = p.full_name
      }
    }
  }

  return NextResponse.json({ reports, photo_counts, user_names })
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
  const fields: Record<string, unknown> = await req.json().catch(() => ({}))

  const str = (v: unknown): string | null => typeof v === "string" ? v : null
  const report_date = str(fields.report_date)
  if (!report_date) return NextResponse.json({ error: "report_date is required" }, { status: 400 })

  const { data: profile } = await supabase.from("user_profiles").select("company_id").eq("user_id", user.id).maybeSingle()
  const company_id = profile?.company_id ?? null

  const file_path = str(fields.file_path)?.trim() || null
  const file_name = str(fields.file_name)?.trim() || null

  const client_id = str(fields.client_id)?.trim() ?? ""
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const useClientId = UUID_RE.test(client_id)

  const rawManpower = fields.manpower_count
  const manpower = typeof rawManpower === "number" ? rawManpower
    : typeof rawManpower === "string" && rawManpower ? parseInt(rawManpower) : null

  const insertData: Record<string, unknown> = {
    report_date,
    project_id: str(fields.project_id) || null,
    prepared_by: str(fields.prepared_by)?.trim() || null,
    weather_conditions: str(fields.weather_conditions)?.trim() || null,
    temperature: str(fields.temperature)?.trim() || null,
    manpower_count: Number.isFinite(manpower) ? manpower : null,
    work_performed: str(fields.work_performed)?.trim() || null,
    equipment: str(fields.equipment)?.trim() || null,
    materials_delivered: str(fields.materials_delivered)?.trim() || null,
    visitors: str(fields.visitors)?.trim() || null,
    issues_delays: str(fields.issues_delays)?.trim() || null,
    safety_notes: str(fields.safety_notes)?.trim() || null,
    file_path,
    file_name,
    company_id,
    uploaded_by: user.id,
  }
  if (useClientId) insertData.id = client_id

  // Crew (0050): stored as jsonb; the derived headcount overwrites
  // manpower_count so pre-crew readers (list/PDF/exports) stay correct.
  if (DAILY_0050_LIVE) {
    const crew = parseCrew(fields.crew)
    if (crew) {
      insertData.crew = crew
      insertData.manpower_count = crewHeadcount(crew)
    }
  }

  const builder = useClientId
    ? supabase.from("daily_reports").upsert(insertData, { onConflict: "id" })
    : supabase.from("daily_reports").insert(insertData)
  const { data, error } = await builder.select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id: data?.[0]?.id, ok: true })
}
