import type { SupabaseClient } from "@supabase/supabase-js"

// ── Manpower assignments — shared types + double-book detection ──────────────
// Phase 3 (write-layer). The manpower_assignments table is company-scoped by RLS
// and additionally carries project_id; everything here is read/written through
// the RLS-scoped server client, so company isolation is the DB's job — never a
// hand-rolled company_id comparison.

export type AssigneeType = "worker" | "vendor"
export type AssignmentStatus = "planned" | "actual"

// Map a Postgres CHECK violation (23514) on the manpower table to a clean 400
// message so a malformed assignee/time pair never surfaces as a 500. Returns null
// when the error isn't one of ours (caller then treats it as a real 500).
export function checkViolationMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error || error.code !== "23514") return null
  const m = error.message ?? ""
  if (m.includes("manpower_assignee_exclusive")) return "An assignment must have exactly one worker or one vendor crew."
  if (m.includes("manpower_time_order")) return "End time must be after start time."
  return "Assignment failed a database validation check."
}

// Normalize a Postgres `time` ("HH:MM:SS") or an <input type=time> value ("HH:MM")
// down to "HH:MM" so lexicographic comparison is exact (zero-padded 24h times
// compare correctly as strings once the seconds tail is dropped).
function hhmm(t: string | null | undefined): string | null {
  if (typeof t !== "string" || !t.trim()) return null
  return t.trim().slice(0, 5)
}

// Two same-day blocks overlap when their [start,end) intervals intersect. A block
// missing either bound is treated as spanning the whole day, so an unscheduled
// assignment conflicts with anything else that day (conservative — we'd rather
// badge a maybe-conflict than miss a real one; double-booking is never blocked).
export function blocksOverlap(
  aStart: string | null, aEnd: string | null,
  bStart: string | null, bEnd: string | null,
): boolean {
  const as = hhmm(aStart), ae = hhmm(aEnd), bs = hhmm(bStart), be = hhmm(bEnd)
  const aAllDay = !as || !ae
  const bAllDay = !bs || !be
  if (aAllDay || bAllDay) return true
  return as! < be! && ae! > bs!
}

// True when `worker_id` already has another non-deleted assignment that day whose
// time block overlaps the given one. Company-wide on purpose (NO project filter):
// the same worker on two different projects the same day IS the double-book we
// want to surface. RLS still scopes the read to the caller's company. `excludeId`
// drops the row being edited so it never conflicts with itself.
export async function workerHasConflict(
  supabase: SupabaseClient,
  args: {
    worker_id: string
    work_date: string
    start_time: string | null
    end_time: string | null
    excludeId?: string
  },
): Promise<boolean> {
  let q = supabase
    .from("manpower_assignments")
    .select("id, start_time, end_time")
    .eq("worker_id", args.worker_id)
    .eq("work_date", args.work_date)
  if (args.excludeId) q = q.neq("id", args.excludeId)

  const { data, error } = await q
  if (error || !data) return false // a failed conflict probe must never block the write
  return data.some(r =>
    blocksOverlap(args.start_time, args.end_time, r.start_time as string | null, r.end_time as string | null),
  )
}
