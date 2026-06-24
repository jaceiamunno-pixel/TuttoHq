import {
  computeCpm,
  createWorkingCalendar,
  type Task,
  type Dependency,
  type DependencyType,
  type WorkingCalendar,
  type CpmResult,
} from "./cpm"

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
  // Nullable since migration 0023: a 'backlog' task may carry no dates. A DATED row
  // (both non-null) is the only kind the CPM engine schedules; a null-dated backlog
  // row rides through to the response WITHOUT an overlay (see computeScheduleCpm).
  start_date: string | null
  end_date: string | null
  is_milestone: boolean
  // Specific days inside the bar the planner marked non-working (migration 0024:
  // date[] NOT NULL DEFAULT '{}'). A voided working day inside [start,end] is
  // subtracted from the derived duration (see deriveDurationDays). Optional here so
  // the engine tolerates a row read before the column existed; treated as [] when
  // absent.
  voided_dates?: string[] | null
  [key: string]: unknown
}

// A schedulable row — both bar dates present. The CPM engine only ever sees these;
// backlog (null-dated) rows are filtered out before the engine in computeScheduleCpm.
type DatedTaskRow = ScheduleTaskRow & { start_date: string; end_date: string }

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

// Count the voided days that actually SHORTEN a bar. A voided date is subtracted from
// the working-day duration only when it (a) is itself a working day and (b) lands
// inside the inclusive [start,end] span — i.e. on an otherwise-counted day. A void on
// a weekend (never counted) or outside the span is harmless and ignored. Deduped, and
// malformed/non-string entries are skipped defensively, so a repeat or stray value can
// never double-subtract.
function countVoidedWorkingDays(
  start_date: string,
  end_date: string,
  voided_dates: readonly string[] | null | undefined,
  calendar: WorkingCalendar,
): number {
  if (!voided_dates || voided_dates.length === 0) return 0
  const startMs = parseIsoDate(start_date).getTime()
  const endMs = parseIsoDate(end_date).getTime()
  const seen = new Set<string>()
  let count = 0
  for (const raw of voided_dates) {
    if (typeof raw !== "string") continue
    const iso = raw.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || seen.has(iso)) continue
    const d = parseIsoDate(iso)
    const ms = d.getTime()
    if (ms < startMs || ms > endMs) continue // outside the span → ignored
    if (!calendar.isWorkingDay(d)) continue // weekend void wasn't counted anyway
    seen.add(iso)
    count++
  }
  return count
}

// Derive the engine's WORKING-day duration from the stored bar dates, minus any days
// the planner voided inside the span. A milestone is 0; otherwise it's the inclusive
// working-day span (start..end), so a single-day task = 1, less one for each voided
// working day that lands inside the bar. We derive from the dates + voids — NOT a
// client-sent duration_days — so the engine input and the stored bar can never
// disagree. Floored at 1 for a real task in case both endpoints land on the same
// weekend day (collapses to one slot) or every counted day is voided.
export function deriveDurationDays(
  start_date: string,
  end_date: string,
  is_milestone: boolean,
  voided_dates: readonly string[] = [],
  calendar: WorkingCalendar = createWorkingCalendar(),
): number {
  if (is_milestone) return 0
  const inclusiveSpan =
    calendar.workingDaysBetween(parseIsoDate(start_date), parseIsoDate(end_date)) + 1
  const voided = countVoidedWorkingDays(start_date, end_date, voided_dates, calendar)
  return Math.max(1, inclusiveSpan - voided)
}

// Day 0 of the schedule = the earliest task start_date in the set (ISO strings sort
// chronologically). Returns null for an empty set (no schedule to compute).
function earliestStart(taskRows: DatedTaskRow[]): string | null {
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
  // Backlog (null-dated) rows aren't schedulable — they have no dates to place on the
  // timeline. They're excluded from the engine entirely (exactly like a soft-deleted
  // row): no duration is derived (deriveDurationDays would deref a null date and throw),
  // and any edge touching one is dropped below by the liveIds filter. They still ride
  // through to the GET response unchanged — assembleSchedule leaves a row with no
  // overlay as-is, so a backlog bar never collapses onto project day-0 or NaNs.
  const datedRows = taskRows.filter(
    (t): t is DatedTaskRow => t.start_date != null && t.end_date != null,
  )
  const tasks: Task[] = datedRows.map((t) => ({
    id: t.id,
    // Voided in-span working days shrink the engine duration too, so the CPM overlay
    // and the stored bar agree on work content (a row without the column → []).
    durationDays: deriveDurationDays(
      t.start_date,
      t.end_date,
      t.is_milestone,
      Array.isArray(t.voided_dates) ? t.voided_dates : [],
      calendar,
    ),
    isMilestone: t.is_milestone,
  }))
  // Only edges whose BOTH endpoints are live tasks in this set may reach the engine.
  // A soft-deleted task's edges PERSIST (soft_delete_schedule_task just sets
  // deleted_at; the FK CASCADE fires only on a hard delete — kept so a restore is
  // lossless), so depRows can contain "dangling" edges pointing at a deleted task.
  // Feeding one to computeCpm makes it return 'unknown_task' BEFORE cycle detection,
  // which would (a) fail the cycle gate OPEN (wouldCreateCycle sees a non-'cycle'
  // error and allows the insert) and (b) collapse the whole-project CPM overlay on
  // GET. A soft-deleted task is not part of the live schedule graph, so dropping its
  // edges yields the correct live subgraph for BOTH the overlay and the acyclicity
  // check — a cycle can only matter among live, schedulable tasks.
  const liveIds = new Set(datedRows.map((t) => t.id))
  const dependencies: Dependency[] = depRows
    .filter((d) => liveIds.has(d.predecessor_id) && liveIds.has(d.successor_id))
    .map((d) => ({
      predecessorId: d.predecessor_id,
      successorId: d.successor_id,
      depType: d.dep_type as DependencyType,
      lagDays: d.lag_days,
    }))
  // projectStartIso must be a valid ISO date even for an empty set; the engine
  // returns an empty (but ok:true) result regardless of the anchor when tasks=[].
  const projectStartIso = earliestStart(datedRows) ?? "2000-01-01"
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
// would close a cycle, so the route can reject 409 without mutating the DB.
// computeScheduleCpm drops dangling edges, so over a live graph the engine can only
// return ok (acyclic) or 'cycle'. We FAIL CLOSED: only a certified-acyclic ok result
// permits the insert; a cycle — or any unexpected non-ok — rejects, so the DB never
// stores a graph the engine couldn't prove acyclic.
export function wouldCreateCycle(
  taskRows: ScheduleTaskRow[],
  depRows: ScheduleDependencyRow[],
  proposed: ProposedEdge,
): { cycle: true; cycleNodeIds: string[] } | { cycle: false } {
  const result = computeScheduleCpm(taskRows, [...depRows, proposed])
  if (result.ok) return { cycle: false }
  return { cycle: true, cycleNodeIds: result.error === "cycle" ? result.cycleNodeIds : [] }
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
  if (m.includes("schedule_task_status")) return "Status must be not_started, in_progress, complete, or backlog."
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
