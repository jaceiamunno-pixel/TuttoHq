import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"
import { parseCrew, crewHeadcount } from "@/lib/daily-crew"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = [
    "report_date", "project_id", "prepared_by",
    "weather_conditions", "temperature", "manpower_count",
    "work_performed", "equipment", "materials_delivered",
    "visitors", "issues_delays", "safety_notes",
  ]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates as Record<string, unknown>).filter(([k]) => allowed.includes(k))
  )

  if (DAILY_0050_LIVE) {
    // Crew: explicit null clears it; a valid array replaces it (and the
    // derived headcount overwrites manpower_count for back-compat readers).
    if ("crew" in updates) {
      const crew = parseCrew(updates.crew)
      safe.crew = crew
      if (crew) safe.manpower_count = crewHeadcount(crew)
    }
    // Last-edit attribution for the "edited after submission" banner (4g).
    safe.updated_at = new Date().toISOString()
    safe.updated_by = user.id
  }

  const { error } = await supabase.from("daily_reports").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

// Two-verb discipline (0050): DELETE is a soft delete — it stamps
// deleted_at and every list query filters it out; the 10 s undo toast
// POSTs [id]/restore to clear it. Pre-0050 the route keeps its original
// hard delete (no column to stamp yet).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("daily_reports").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (DAILY_0050_LIVE) {
    const { error } = await supabase.from("daily_reports")
      .update({ deleted_at: new Date().toISOString() }).eq("id", id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, soft: true })
  }

  const { error } = await supabase.from("daily_reports").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
