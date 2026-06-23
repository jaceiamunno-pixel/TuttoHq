import {
  computeCpm,
  createWorkingCalendar,
  type Task,
  type Dependency,
  type DependencyType,
  type WorkingCalendar,
  type CpmResult,
} from "@/lib/schedule/cpm"

// ── Schedule API mapping seam — ADR-011 Phase 3, Slice 2 ─────────────────────
// The CPM engine (cpm.ts) is PURE and DB-agnostic. This module is the ONLY place
// that knows about DB rows: it maps schedule_tasks/schedule_dependencies rows into
// the engine's Task/Dependency shapes, runs computeCpm, and merges the result back
// onto the rows. Routes stay thin; all the row↔engine translation lives here so it
// is unit-testable in isolation from Supabase.

// Minimal row shapes the mapping depends on. Routes pass the full DB row (more
// columns than these); only these fields drive the engine. `[key: string]` keeps
// the rest of the row intact so it rides through to the response untouched.
export interface ScheduleTaskRow {
  id: string
  start_date: string
  end_date: string
  is_milestone: boolean
  [key: string]: unknown
}

export interface ScheduleDependencyRow {
  id: string
  predecessor_id: string
  successor_id: string
  dep_type: string
  lag_days: number
  [key: string]: unknown
}

// The proposed (not-yet-inserted) edge used by the cycle gate. Same shape as a row
// minus the persisted columns the engine never reads.
export interface ProposedEdge {
  predecessor_id: string
  successor_id: string
  dep_type: string
  lag_days: number
}

// Parse an ISO yyyy-mm-dd to a UTC-midnight Date, matching cpm.ts's own internal
// parsing (TZ/DST-safe). Kept local because cpm.ts deliberately doesn't export it.
function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

// Derive the engine's WORKING-day duration from the stored bar dates. A milestone
// is 0; otherwise it's the inclusive working-day span (start..end), so a single-day
// task = 1. We derive from the dates — NOT a client-sent duration_days — so the
// engine input and the stored bar can never disagree. Floored at 1 for a real task
// in case both endpoints land on the same weekend day (collapses to one slot).
export function deriveDurationDays(
  start_date: string,
  end_date: string,
  is_milestone: boolean,
  calendar: WorkingCalendar = createWorkingCalendar(),
): number {
  if (is_milestone) return 0
  const span = calendar.workingDaysBetween(parseIsoDate(start_date), parseIsoDate(end_date))
  return Math.max(1, span + 1)
}

// Day 0 of the schedule = the earliest task start_date in the set (ISO strings sort
// chronologically). Returns null for an empty set (no schedule to compute).
function earliestStart(taskRows: ScheduleTaskRow[]): string | null {
  let min: string | null = null
  for (const t of taskRows) {
    if (min === null || t.start_date < min) min = t.start_date
  }
  return min
}

// Map rows → engine shapes → computeCpm. ONE calendar instance is shared between
// duration derivation and the engine so the two can't drift. Returns the engine's
// discriminated-union result verbatim (ok:true with the overlay, or ok:false).
export function computeScheduleCpm(
  taskRows: ScheduleTaskRow[],
  depRows: Array<ScheduleDependencyRow | ProposedEdge>,
): CpmResult {
  const calendar = createWorkingCalendar()
  const tasks: Task[] = taskRows.map((t) => ({
    id: t.id,
    durationDays: deriveDurationDays(t.start_date, t.end_date, t.is_milestone, calendar),
    isMilestone: t.is_milestone,
  }))
  const dependencies: Dependency[] = depRows.map((d) => ({
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    depType: d.dep_type as DependencyType,
    lagDays: d.lag_days,
  }))
  // projectStartIso must be a valid ISO date even for an empty set; the engine
  // returns an empty (but ok:true) result regardless of the anchor when tasks=[].
  const projectStartIso = earliestStart(taskRows) ?? "2000-01-01"
  return computeCpm(tasks, dependencies, projectStartIso, { calendar })
}

// The per-task CPM overlay merged onto each row in the GET response.
interface CpmTaskOverlay {
  earlyStart: number
  earlyFinish: number
  lateStart: number
  lateFinish: number
  totalFloat: number
  isCritical: boolean
  earlyStartDate: string
  earlyFinishDate: string
  lateStartDate: string
  lateFinishDate: string
}

// The compact CPM summary returned alongside the bars.
type CpmSummary =
  | { ok: true; criticalTaskIds: string[]; criticalPath: string[]; projectEnd: string; projectDurationDays: number }
  | { ok: false; error: string }

export interface ScheduleResponse {
  tasks: Array<ScheduleTaskRow & Partial<CpmTaskOverlay>>
  dependencies: ScheduleDependencyRow[]
  cpm: CpmSummary
}

// Build the full GET payload: bars + edges + CPM overlay. On a CPM error (should
// not happen on read since inserts are cycle-gated, but defensively) the bars are
// returned WITHOUT the overlay and cpm:{ok:false,error} so the UI can still render
// the schedule from the raw dates. NEVER throws on a CPM error — degrade to rows.
export function assembleSchedule(
  taskRows: ScheduleTaskRow[],
  depRows: ScheduleDependencyRow[],
): ScheduleResponse {
  const cpm = computeScheduleCpm(taskRows, depRows)
  if (!cpm.ok) {
    return { tasks: taskRows, dependencies: depRows, cpm: { ok: false, error: cpm.error } }
  }
  const overlayById = new Map(cpm.tasks.map((t) => [t.id, t]))
  const tasks = taskRows.map((row) => {
    const o = overlayById.get(row.id)
    if (!o) return row
    return {
      ...row,
      earlyStart: o.earlyStart,
      earlyFinish: o.earlyFinish,
      lateStart: o.lateStart,
      lateFinish: o.lateFinish,
      totalFloat: o.totalFloat,
      isCritical: o.isCritical,
      earlyStartDate: o.earlyStartDate,
      earlyFinishDate: o.earlyFinishDate,
      lateStartDate: o.lateStartDate,
      lateFinishDate: o.lateFinishDate,
    }
  })
  return {
    tasks,
    dependencies: depRows,
    cpm: {
      ok: true,
      criticalTaskIds: cpm.criticalTaskIds,
      criticalPath: cpm.criticalPath,
      projectEnd: cpm.projectEnd,
      projectDurationDays: cpm.projectDurationDays,
    },
  }
}

// CYCLE GATE — run the SAME engine over the would-be graph (existing edges + the
// proposed one) BEFORE inserting. Returns the offending node ids when the new edge
// would close a cycle, so the route can reject 409 without mutating the DB. Callers
// must have already confirmed both endpoints are tasks in the set (so the only
// non-ok outcome here is 'cycle', never unknown_task).
export function wouldCreateCycle(
  taskRows: ScheduleTaskRow[],
  depRows: ScheduleDependencyRow[],
  proposed: ProposedEdge,
): { cycle: true; cycleNodeIds: string[] } | { cycle: false } {
  const result = computeScheduleCpm(taskRows, [...depRows, proposed])
  if (!result.ok && result.error === "cycle") {
    return { cycle: true, cycleNodeIds: result.cycleNodeIds }
  }
  return { cycle: false }
}

// Map a Postgres CHECK violation (23514) on schedule_tasks to a clean 400 message
// so a bad date/pct/status never surfaces as a 500. Returns null when the error
// isn't one of ours (caller treats it as a real 500). Mirrors checkViolationMessage
// in lib/manpower.ts.
export function scheduleTaskCheckMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error || error.code !== "23514") return null
  const m = error.message ?? ""
  if (m.includes("schedule_task_date_order")) return "End date must be on or after the start date."
  if (m.includes("schedule_task_pct")) return "Percent complete must be between 0 and 100."
  if (m.includes("schedule_task_status")) return "Status must be not_started, in_progress, or complete."
  return "Task failed a database validation check."
}

// Map a CHECK violation (23514) on schedule_dependencies to a clean 400. The
// UNIQUE (23505) and FK (23503) violations are mapped by the route, not here.
export function scheduleDepCheckMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error || error.code !== "23514") return null
  const m = error.message ?? ""
  if (m.includes("no_self_dependency")) return "A task cannot depend on itself."
  if (m.includes("schedule_dep_type")) return "Dependency type must be FS, SS, FF, or SF."
  return "Dependency failed a database validation check."
}
