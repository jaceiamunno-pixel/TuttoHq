import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// ── Schedule → Manpower crew-demand overlay (ADR-014, Phase 1) ───────────────
// READ-ONLY derivation. A dated, crewed schedule_tasks bar projects a PLANNED
// crew-demand number onto the per-project manpower view for every calendar day it
// covers. We never auto-create assignment rows and never mutate a task — the view
// shows planned demand (from the schedule) next to booked (from manpower_assignments)
// and a SOFT staffing-gap badge when they differ. This is the SINGLE place the demand
// math lives, so the manpower view is its only consumer.
//
// Standard cookie server client; RLS company-scopes the read (schedule_tasks.company_id
// = get_my_company_id()). project_id is a REQUIRED additional filter, never the security
// boundary — one project's demand never leaks onto another's manpower view.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Cap the expansion window. Per-day demand is O(days × tasks); a month-sized window is
// the real consumer, so a window longer than ~13 months is almost certainly a mistake
// and would let one call expand into a huge map. Reject it with a clean 400.
const MAX_WINDOW_DAYS = 400

const DAY_MS = 86_400_000
// Parse yyyy-mm-dd → UTC-midnight epoch ms (TZ/DST-safe; stepping by DAY_MS over UTC
// midnights never drifts). Mirrors the schedule engine's own UTC date parsing.
function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  return Date.UTC(y, m - 1, d)
}
function utcMsToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// First/last calendar day of the month containing `d`, as YYYY-MM-DD — the default
// read window when the client sends neither bound (mirrors /api/manpower-assignments).
function monthBounds(d: Date): { from: string; to: string } {
  const y = d.getUTCFullYear(), m = d.getUTCMonth()
  const iso = (dt: Date) => dt.toISOString().slice(0, 10)
  return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) }
}

interface CrewedTaskRow {
  start_date: string | null
  end_date: string | null
  crew_size: number | null
  voided_dates: string[] | null
}

// GET /api/schedule-tasks/crew-demand?project_id=<uuid>&from=&to=
//   → { demand: { "YYYY-MM-DD": <int>, … } }  (only days with demand > 0 appear)
//
// Per-day PLANNED crew demand over [from,to] for one project. A dated, non-milestone,
// crewed, live task contributes crew_size to EVERY calendar day in [start_date,end_date]
// it covers within the window, EXCEPT days listed in that task's voided_dates. Demand is
// over CALENDAR days (NOT the CPM working-day calendar) — a weekend inside a span still
// projects demand unless voided — because this overlays a literal day-by-day manpower
// grid. voided_dates is respected PER TASK: a date voided on task X still counts for task
// Y if not voided there. Everything is fetched in ONE in-window query and expanded
// per-day server-side (no N+1).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const projectId = sp.get("project_id")?.trim() || null
  const fromRaw = sp.get("from")?.trim() || null
  const toRaw = sp.get("to")?.trim() || null

  if (!projectId || !UUID_RE.test(projectId)) {
    return NextResponse.json({ error: "project_id (uuid) is required" }, { status: 400 })
  }
  if (fromRaw && !DATE_RE.test(fromRaw)) return NextResponse.json({ error: "Invalid from date" }, { status: 400 })
  if (toRaw && !DATE_RE.test(toRaw)) return NextResponse.json({ error: "Invalid to date" }, { status: 400 })

  // Resolve a FINITE window. Both absent → current month (same default as
  // /api/manpower-assignments). Unlike that list route, per-day expansion can't honor an
  // open-ended single bound, so a lone bound fills the other from its own month — keeping
  // the window finite and predictable while still defaulting both-absent to the month.
  const def = monthBounds(new Date())
  const from = fromRaw ?? (toRaw ? monthBounds(new Date(isoToUtcMs(toRaw))).from : def.from)
  const to = toRaw ?? (fromRaw ? monthBounds(new Date(isoToUtcMs(fromRaw))).to : def.to)

  if (from > to) return NextResponse.json({ error: "from must be on or before to" }, { status: 400 })
  const windowDays = Math.round((isoToUtcMs(to) - isoToUtcMs(from)) / DAY_MS) + 1
  if (windowDays > MAX_WINDOW_DAYS) {
    return NextResponse.json({ error: `Window too large (max ${MAX_WINDOW_DAYS} days)` }, { status: 400 })
  }

  // One query: live, dated, non-milestone, crewed tasks for this project that OVERLAP the
  // window (start_date <= to AND end_date >= from). RLS adds the company scope.
  const { data, error } = await supabase
    .from("schedule_tasks")
    .select("start_date, end_date, crew_size, voided_dates")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .eq("is_milestone", false)
    .not("crew_size", "is", null)
    .not("start_date", "is", null)
    .not("end_date", "is", null)
    .lte("start_date", to)
    .gte("end_date", from)

  if (error) {
    console.error("Failed to load schedule crew demand:", error)
    return NextResponse.json({ error: "Failed to load crew demand" }, { status: 500 })
  }

  const fromMs = isoToUtcMs(from)
  const toMs = isoToUtcMs(to)
  const demand: Record<string, number> = {}

  for (const t of (data ?? []) as CrewedTaskRow[]) {
    // The not-null filters guarantee these, but narrow defensively before the math.
    if (t.start_date == null || t.end_date == null || t.crew_size == null) continue
    const crew = t.crew_size
    if (crew <= 0) continue // crew_size=0 is valid but projects no demand

    const voids = new Set(Array.isArray(t.voided_dates) ? t.voided_dates : [])

    // Clamp the task span to the window (ISO dates sort lexicographically, so max/min
    // via string compare is safe). Expand inclusive, skipping this task's voided days.
    let dayMs = Math.max(isoToUtcMs(t.start_date), fromMs)
    const endMs = Math.min(isoToUtcMs(t.end_date), toMs)
    for (; dayMs <= endMs; dayMs += DAY_MS) {
      const key = utcMsToIso(dayMs)
      if (voids.has(key)) continue
      demand[key] = (demand[key] ?? 0) + crew
    }
  }

  return NextResponse.json({ demand })
}
