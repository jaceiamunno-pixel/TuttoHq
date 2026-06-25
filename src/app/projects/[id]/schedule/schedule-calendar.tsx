"use client"

import { useCallback, useMemo, useRef, useState } from "react"

// ── Schedule month-calendar view (ADR-011 / ADR-012) ─────────────────────────
// A read-only month-grid rendering of the SAME schedule_tasks the Gantt loads —
// it takes the parent's already-fetched `tasks` as a prop, so there is NO new
// fetch, route, or schema. The point is parity with the THP PM's hand-built
// Bluebeam lookahead: a 7-col Sun–Sat month grid where each dated task draws as a
// CONTINUOUS BAR across [start_date, end_date] (weekends included, voided days
// hatched) — the exact same span geometry the planning board uses (useSpanLayout),
// just read-only (a bar is a button that opens the task editor; no drag/resize/void).
// Milestones stay a single dated diamond.
//
// SCOPE + EXPORT (ADR-012, calendar follow-up): a keyword filter + per-task
// checkboxes narrow which tasks render — this is THP's "select my scope" tool,
// reproduced over the already-loaded tasks (pure component state; no fetch / route
// / schema for the filter). The "Export PDF" button POSTs the CHECKED ids to the
// read-only /api/schedule-export/calendar route, which re-renders this same grid
// server-side through the shared pdf-lib engine and streams a handout PDF back.
//
// Visual language mirrors <ManpowerCalendar> (PR #42) — same month chrome,
// weekday row, day-number cells, and chip styling — so the two calendars read the
// same. It isn't the shared component (that one is welded to the assignments API
// with its own fetch + form modals); the grid skeleton is mirrored here instead.
//
// Multi-month jobs page ONE MONTH AT A TIME (matching the multi-page source PDF):
// the pager steps through only the months that actually contain (shown) tasks.
// Critical tasks (criticalSet, from the same CPM overlay the Gantt uses) are red,
// so the two views agree. Clicking a bar opens the existing task editor.

interface CalendarTask {
  id: string
  name: string
  phase?: string | null
  start_date: string // YYYY-MM-DD (stored date — the chip's day; NOT the CPM overlay)
  // Present + non-null for a dated/scheduled task; the planning board spans the bar
  // across [start_date, end_date]. The read-only chip view only reads start_date.
  end_date?: string | null
  duration_days: number | null
  is_milestone: boolean
  // Days inside the bar marked non-working (migration 0024). The planning board hatches
  // these; absent/undefined → none.
  voided_dates?: string[] | null
  percent_complete?: number
  crew_size?: number | null
  status?: string
}

// The undated backlog rows shown in the planning rail. A drag onto a day cell schedules
// one (assigns start/end). duration_days drives the auto-span on drop (null → 1-day).
interface BacklogTask {
  id: string
  name: string
  phase?: string | null
  duration_days: number | null
  is_milestone: boolean
  crew_size?: number | null
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// Parse/format from parts so a date never shifts across the UTC midnight boundary.
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function todayKey(): string {
  return ymd(new Date())
}
const monthKeyOf = (iso: string) => iso.slice(0, 7) // "YYYY-MM"
// "2026-07" → "Jul 2026" (pager-month label reused for the export filename).
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

interface Cell { key: string; day: number; inMonth: boolean; isToday: boolean }

// Visible month as 7-wide week rows. Lead days back-fill the prior month so week 1
// starts on Sunday; trailing days fill the last week out to Saturday.
function buildMonthGrid(year: number, month0: number, tKey: string): Cell[][] {
  const startDow = new Date(year, month0, 1).getDay()
  const daysInMonth = new Date(year, month0 + 1, 0).getDate()
  const weeks = Math.ceil((startDow + daysInMonth) / 7)
  const first = new Date(year, month0, 1 - startDow)
  const cells: Cell[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)
    const key = ymd(d)
    cells.push({ key, day: d.getDate(), inMonth: d.getMonth() === month0, isToday: key === tKey })
  }
  const rows: Cell[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

const durationLabel = (t: { is_milestone: boolean; duration_days: number | null }) =>
  t.is_milestone || t.duration_days === 0
    ? "milestone"
    : t.duration_days == null
      ? ""
      : `${t.duration_days} day${t.duration_days === 1 ? "" : "s"}`

// ── Planning-board date helpers — LOCAL-time parts, matching buildMonthGrid ───
// buildMonthGrid builds cells with local `new Date(...)`; these mirror that so a key
// (YYYY-MM-DD) ↔ Date round-trips without a UTC-midnight shift.
function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number)
  return new Date(y, m - 1, d)
}
function addDaysKey(key: string, n: number): string {
  const dt = keyToDate(key)
  dt.setDate(dt.getDate() + n)
  return ymd(dt)
}
const isWeekendKey = (key: string) => { const d = keyToDate(key).getDay(); return d === 0 || d === 6 }
// Working days forward from `key` (key = day 0); skips Sat/Sun. Used to AUTO-SPAN a
// dropped task: end = start + (duration − 1) working days. The route re-derives the
// stored duration from the dates, so this only needs to land the calendar end-day.
function addWorkingDaysKey(key: string, n: number): string {
  if (n <= 0) return key
  const dt = keyToDate(key)
  let added = 0
  while (added < n) {
    dt.setDate(dt.getDate() + 1)
    const dow = dt.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return ymd(dt)
}

// Filename-safe slug of the project name for the downloaded PDF.
const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"

export default function ScheduleCalendar({
  tasks, backlogTasks = [], criticalSet, onEditTask, onPatchTask, projectId, projectName,
}: {
  tasks: CalendarTask[]
  backlogTasks?: BacklogTask[]
  criticalSet: Set<string>
  onEditTask: (task: CalendarTask) => void
  // Generic PATCH passthrough (project-schedule.patchTask) — schedules/resizes/voids a
  // task and refetches. Optional so the read-only export path renders without it.
  onPatchTask?: (id: string, patch: Record<string, unknown>) => Promise<boolean>
  projectId: string
  projectName: string
}) {
  const tKey = useMemo(() => todayKey(), [])

  // ── Planning board — an EXPAND of this calendar (not a new tab). When on, the month
  // grid spans bars across [start,end] and a backlog rail sits alongside for drag-to-
  // schedule. The read-only chip grid + export scope panel show when it's off. Only
  // available when a writer (onPatchTask) is wired in.
  const canPlan = !!onPatchTask
  const [planning, setPlanning] = useState(false)

  // ── Scope state — pure UI over the loaded tasks (no fetch / route / schema) ───
  // `excluded` holds the EXPLICITLY-unchecked ids; everything else is checked. This
  // makes "all checked" the default (an empty set) and keeps a freshly-imported task
  // checked automatically (it isn't in `excluded`). A task is SHOWN on the calendar
  // (and eligible for export) only when it is checked AND matches the keyword filter.
  const [filter, setFilter] = useState("")
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const isChecked = useCallback((id: string) => !excluded.has(id), [excluded])

  const matchesFilter = useCallback(
    (t: CalendarTask) => {
      const f = filter.trim().toLowerCase()
      return !f || t.name.toLowerCase().includes(f)
    },
    [filter],
  )

  // The filter-matching tasks shown in the checkbox picker (regardless of checked,
  // so an unchecked one can be re-checked). Stable name order for a steady list.
  const pickerTasks = useMemo(
    () => tasks.filter(matchesFilter).sort((a, b) => a.name.localeCompare(b.name)),
    [tasks, matchesFilter],
  )
  // What actually renders on the grid + exports: checked AND filter-matching.
  const shownTasks = useMemo(
    () => tasks.filter((t) => isChecked(t.id) && matchesFilter(t)),
    [tasks, isChecked, matchesFilter],
  )
  const checkedCount = useMemo(() => tasks.filter((t) => isChecked(t.id)).length, [tasks, isChecked])

  // Each scope change also clears any stale export-error banner.
  const toggle = useCallback((id: string) => {
    setExportError(null)
    setExcluded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])
  const selectAll = useCallback(() => { setExportError(null); setExcluded(new Set()) }, [])
  const clearAll = useCallback(() => { setExportError(null); setExcluded(new Set(tasks.map((t) => t.id))) }, [tasks])
  // "Select shown" — check every filter-matching task, so filter + check compose
  // (e.g. Clear all → filter "masonry" → Select shown ⇒ only masonry checked).
  const selectShown = useCallback(() => {
    setExportError(null)
    setExcluded((s) => { const n = new Set(s); for (const t of pickerTasks) n.delete(t.id); return n })
  }, [pickerTasks])

  // The months that actually contain tasks (by start day), ascending. One is shown at
  // a time — matching how the PM's multi-page calendar reads. In planning mode the
  // pager spans EVERY dated task (not just the export-checked subset) so a bar is never
  // stranded on an unreachable month.
  const months = useMemo(() => {
    const set = new Set<string>()
    const src = planning ? tasks : shownTasks
    for (const t of src) if (t.start_date) set.add(monthKeyOf(t.start_date))
    return [...set].sort()
  }, [planning, tasks, shownTasks])

  // Default to the first month at or after the current one, else the last (so a
  // wholly-past schedule opens on its most recent month). Empty → current month.
  const [activeMonth, setActiveMonth] = useState<string | null>(null)
  const fallbackMonth = useMemo(() => {
    if (months.length === 0) return tKey.slice(0, 7)
    const cur = tKey.slice(0, 7)
    return months.find((m) => m >= cur) ?? months[months.length - 1]
  }, [months, tKey])
  const current = activeMonth && months.includes(activeMonth) ? activeMonth : fallbackMonth
  const idx = months.indexOf(current)

  const [year, month0] = useMemo(() => {
    const [y, m] = current.split("-").map(Number)
    return [y, m - 1] as [number, number]
  }, [current])

  const grid = useMemo(() => buildMonthGrid(year, month0, tKey), [year, month0, tKey])
  const monthCount = useMemo(
    () => (planning ? tasks : shownTasks).filter((t) => t.start_date && monthKeyOf(t.start_date) === current).length,
    [planning, tasks, shownTasks, current],
  )

  const canPrev = idx > 0
  const canNext = idx >= 0 && idx < months.length - 1

  // ── Export the currently-shown calendar (checked + filtered) as a PDF ─────────
  // Sends ONLY the checked task ids; the route intersects them against the caller's
  // RLS-visible tasks for the project and renders one month page per month that holds
  // a selected task. Nothing is persisted server-side; the response streams back.
  const exportPdf = useCallback(async () => {
    const ids = shownTasks.map((t) => t.id)
    if (ids.length === 0) { setExportError("Check at least one task to export."); return }
    setExporting(true)
    setExportError(null)
    try {
      const res = await fetch("/api/schedule-export/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, task_ids: ids }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error ?? `Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const span = months.length === 1 ? months[0] : months.length > 1 ? `${months[0]}_${months[months.length - 1]}` : current
      a.download = `${slug(projectName)}-schedule-${span}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }, [shownTasks, projectId, projectName, months, current])

  return (
    <div>
      {/* ── Expand-to-plan toggle — flips this read calendar into the planning board
          (drag backlog → schedule, drag a bar edge → resize, click a day → void). ── */}
      {canPlan && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {planning ? (
              <p className="text-[12px] text-[#64748B]">
                <span className="font-semibold text-[#475569]">Planning board</span> — drag a backlog task onto a day to schedule it, drag a bar’s right edge to set the finish, click a day inside a bar to mark it non-working.
              </p>
            ) : (
              <p className="text-[12px] text-[#64748B]">View the month, or expand to the planning board to schedule the backlog by dragging onto the calendar.</p>
            )}
          </div>
          <button
            onClick={() => setPlanning((p) => !p)}
            className={`flex-shrink-0 h-8 px-3.5 rounded-md text-[12px] font-semibold inline-flex items-center gap-1.5 transition-colors ${
              planning
                ? "bg-[#7B9BB5] text-white hover:bg-[#6A8AA4]"
                : "border border-[#E2E8F0] bg-white text-[#0F172A] hover:bg-[#F8FAFC]"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={planning ? "M9 9L4 4m0 0v5m0-5h5m6 6l5 5m0 0v-5m0 5h-5" : "M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"} /></svg>
            {planning ? "Exit planning" : "Expand to plan"}
            {!planning && backlogTasks.length > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#EEF2F6] text-[#475569] text-[10px] font-bold">{backlogTasks.length}</span>
            )}
          </button>
        </div>
      )}

      {/* ── Scope panel: keyword filter + per-task checkboxes + Export ─────────── */}
      {!planning && (
      <div className="mb-4 rounded-xl border border-[#E2E8F0] bg-white p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94A3B8]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
            <input
              value={filter}
              onChange={(e) => { setExportError(null); setFilter(e.target.value) }}
              placeholder="Filter tasks — e.g. masonry, framing, spray…"
              className="w-full h-8 pl-8 pr-3 rounded-md border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"
            />
          </div>
          <button onClick={selectAll} className="h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Select all</button>
          <button onClick={clearAll} className="h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Clear all</button>
          {filter.trim() && (
            <button onClick={selectShown} className="h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Select shown</button>
          )}
          <button
            onClick={exportPdf}
            disabled={exporting || shownTasks.length === 0}
            className="h-8 px-3.5 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            {exporting ? "Exporting…" : "Export PDF"}
          </button>
        </div>

        {/* Checkable task pills — the filter narrows this list; checking drives the
            grid + export. Scrolls past a few rows so the calendar stays the focus. */}
        {pickerTasks.length === 0 ? (
          <p className="mt-3 text-[12px] text-[#94A3B8]">No tasks match “{filter}”.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {pickerTasks.map((t) => {
              const on = isChecked(t.id)
              const crit = criticalSet.has(t.id)
              return (
                <label
                  key={t.id}
                  title={`${t.name}, ${durationLabel(t)}`}
                  className={`inline-flex items-center gap-1.5 max-w-[220px] rounded-full border px-2.5 py-1 text-[12px] cursor-pointer transition-colors ${
                    on
                      ? crit ? "bg-red-50 border-red-300 text-red-700" : "bg-[#EEF2F6] border-[#CBD5E1] text-[#334155]"
                      : "bg-white border-[#E2E8F0] text-[#94A3B8]"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(t.id)}
                    className="w-3.5 h-3.5 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]/40"
                  />
                  {t.is_milestone && <span className={`w-2 h-2 rotate-45 flex-shrink-0 ${on ? (crit ? "bg-red-600" : "bg-[#475569]") : "bg-[#CBD5E1]"}`} />}
                  <span className="truncate">{t.name}</span>
                </label>
              )
            })}
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#64748B]">
          <span><span className="font-semibold text-[#0F172A]">{checkedCount}</span> of {tasks.length} task{tasks.length === 1 ? "" : "s"} on the calendar{filter.trim() ? ` · ${shownTasks.length} shown for “${filter.trim()}”` : ""}</span>
          {exportError && <span className="text-red-600 font-medium">{exportError}</span>}
        </div>
      </div>
      )}

      {/* Month chrome: ◀ Month Year ▶ — pages only across months that hold tasks */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => canPrev && setActiveMonth(months[idx - 1])}
            disabled={!canPrev}
            aria-label="Previous month with tasks"
            className="h-8 w-8 grid place-items-center rounded-md border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC] disabled:opacity-40 disabled:hover:bg-white"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <span className="text-[14px] font-semibold text-[#0F172A] min-w-[132px] text-center">{MONTHS[month0]} {year}</span>
          <button
            onClick={() => canNext && setActiveMonth(months[idx + 1])}
            disabled={!canNext}
            aria-label="Next month with tasks"
            className="h-8 w-8 grid place-items-center rounded-md border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC] disabled:opacity-40 disabled:hover:bg-white"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-[#64748B]">
          {months.length > 1 && <span className="hidden sm:inline">Month {idx + 1} of {months.length} with tasks</span>}
          <span>{monthCount} task{monthCount === 1 ? "" : "s"} this month</span>
        </div>
      </div>

      {/* ── Planning board (expanded) — spanned bars + backlog rail ───────────── */}
      {planning && onPatchTask ? (
        <PlanningBoard
          grid={grid}
          tasks={tasks}
          backlogTasks={backlogTasks}
          criticalSet={criticalSet}
          onPatchTask={onPatchTask}
          onEditTask={onEditTask}
        />
      ) : (
        /* Read-only spanned calendar — same bar geometry as the planning board.
           Always rendered (it IS the empty state). */
        <ReadOnlyCalendar grid={grid} tasks={shownTasks} criticalSet={criticalSet} onEditTask={onEditTask} />
      )}
    </div>
  )
}

// ── Planning board — spanned bars over the month grid + a draggable backlog rail ──
// EXPAND of the calendar view (Step 4b). Bars draw CONTINUOUSLY across every cell in
// [start,end] INCLUDING weekends (the line never breaks). Every interaction is
// cell-grid based — drop = which cell, edge-drag = which cell the pointer is over —
// so it stays stable on the day grid (no pixel/zoom math like the Gantt canvas):
//   • DROP a backlog task on a day → schedules it (start = that day; end auto-spans the
//     task's working-day duration, or 1 day when it has none).
//   • DRAG a bar's trailing edge along the row → end_date = the day under the pointer
//     (resizes an already-scheduled bar too).
//   • CLICK a day inside a bar → toggles it void (hatched + subtracted from duration);
//     the bar still draws straight across it.
// Every write goes through onPatchTask (project-schedule.patchTask), which refetches, so
// the Gantt + calendar + backlog stay in lock-step.

const DAYNUM_H = 24 // px reserved at the top of each week row for the day numbers
const LANE_H = 22 // px per stacked bar lane
const PLAN_BAR_H = 18

interface PlanSeg {
  task: CalendarTask
  startCol: number // 0..6 within the week
  endCol: number // 0..6 within the week
  lane: number
  isHead: boolean // the bar's true start lands in this week (label + rounded left)
  isTail: boolean // the bar's true end lands in this week (resize grip + rounded right)
}

// ── Shared span geometry — used by BOTH the read-only calendar and the planning board ──
// Given the month's week rows and a set of DATED tasks (each with start_date + end_date),
// it (1) packs every task into a stable global lane so its bar reads as one continuous
// band across every week it spans, and (2) slices each task into per-week bar segments
// clamped to the week. `effEnd` supplies the end key used for layout — the planning board
// feeds a live resize-preview end; the read-only view passes the stored end. Returns the
// per-week segments + the uniform week-row height (also the planning hit-test's row pitch).
// This is the ONE geometry both calendars share — neither view invents its own.
function useSpanLayout(weeks: Cell[][], sourceTasks: CalendarTask[], effEnd: (t: CalendarTask) => string) {
  const gridFirst = weeks[0][0].key
  const gridLast = weeks[weeks.length - 1][6].key

  // Dated tasks intersecting the visible grid (string compare is fine for YYYY-MM-DD).
  const dated = useMemo(
    () => sourceTasks.filter((t) => t.start_date && t.end_date && t.start_date <= gridLast && (t.end_date as string) >= gridFirst),
    [sourceTasks, gridFirst, gridLast],
  )

  // Global lane packing (sorted by start; stored ends) so a task keeps ONE lane across
  // every week it spans → the bar reads as a single continuous band. Greedy: reuse the
  // lowest lane whose last end is strictly before this task's start.
  const { laneOf, laneCount } = useMemo(() => {
    const sorted = [...dated].sort((a, b) =>
      a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id < b.id ? -1 : 1,
    )
    const laneEnds: string[] = []
    const map = new Map<string, number>()
    for (const t of sorted) {
      const end = t.end_date as string
      let lane = 0
      while (lane < laneEnds.length && !(laneEnds[lane] < t.start_date)) lane++
      if (laneEnds[lane] === undefined || laneEnds[lane] < end) laneEnds[lane] = end
      map.set(t.id, lane)
    }
    return { laneOf: map, laneCount: Math.max(1, laneEnds.length) }
  }, [dated])

  const WEEK_H = DAYNUM_H + laneCount * LANE_H + 6

  // Per-week bar segments, clamped to the week, each at the task's global lane.
  const weekSegs = useMemo(() => {
    return weeks.map((week) => {
      const weekFirst = week[0].key
      const weekLast = week[6].key
      const segs: PlanSeg[] = []
      for (const t of dated) {
        const tStart = t.start_date
        const tEnd = effEnd(t)
        if (tStart > weekLast || tEnd < weekFirst) continue
        const segStart = tStart > weekFirst ? tStart : weekFirst
        const segEnd = tEnd < weekLast ? tEnd : weekLast
        const startCol = week.findIndex((c) => c.key === segStart)
        const endCol = week.findIndex((c) => c.key === segEnd)
        segs.push({
          task: t,
          startCol: startCol < 0 ? 0 : startCol,
          endCol: endCol < 0 ? 6 : endCol,
          lane: laneOf.get(t.id) ?? 0,
          isHead: tStart >= weekFirst && tStart <= weekLast,
          isTail: tEnd >= weekFirst && tEnd <= weekLast,
        })
      }
      return segs
    })
  }, [weeks, dated, effEnd, laneOf])

  return { weekSegs, WEEK_H }
}

// Read-only consumers feed the STORED end (no resize preview). Module-level so its
// identity is stable across renders → useSpanLayout's weekSegs memo doesn't churn.
const storedEnd = (t: CalendarTask) => t.end_date as string

// ── Read-only spanned calendar — the !planning month view ─────────────────────
// Mirrors the planning board's calendar card (same month chrome, week rows, weekend
// shading, today pill) and draws bars with the SAME useSpanLayout geometry — but every
// bar is just a button that opens the task editor. No drag, no resize, no void-toggle,
// no backlog rail. Voided days still render their hatch (read-only).
function ReadOnlyCalendar({ grid, tasks, criticalSet, onEditTask }: {
  grid: Cell[][]
  tasks: CalendarTask[]
  criticalSet: Set<string>
  onEditTask: (task: CalendarTask) => void
}) {
  const weeks = grid
  const { weekSegs, WEEK_H } = useSpanLayout(weeks, tasks, storedEnd)

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
      <div className="grid grid-cols-7 bg-[#FAFBFC] border-b border-[#E2E8F0]">
        {DOW.map((d) => (
          <div key={d} className="py-2 text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
            <span className="sm:hidden">{d[0]}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}
      </div>
      <div>
        {weeks.map((week, wIdx) => (
          <div key={wIdx} className="relative border-b border-[#EEF1F4] last:border-b-0" style={{ height: WEEK_H }}>
            {/* Background day cells */}
            <div className="absolute inset-0 grid grid-cols-7">
              {week.map((cell) => {
                const weekend = isWeekendKey(cell.key)
                return (
                  <div
                    key={cell.key}
                    className={`relative border-r border-[#F1F5F9] last:border-r-0 ${!cell.inMonth ? "bg-[#FAFBFC]" : weekend ? "bg-[#FBFCFD]" : "bg-white"}`}
                  >
                    <span
                      className={`absolute top-1 left-1.5 text-[11px] font-semibold ${
                        cell.isToday
                          ? "grid place-items-center w-5 h-5 -ml-0.5 rounded-full bg-[#7B9BB5] text-white"
                          : !cell.inMonth ? "text-[#CBD5E1]" : "text-[#475569]"
                      }`}
                    >
                      {cell.day}
                    </span>
                  </div>
                )
              })}
            </div>
            {/* Bars overlay — read-only (click opens the editor). */}
            {weekSegs[wIdx].map((seg) => (
              <PlanBar
                key={seg.task.id}
                seg={seg}
                week={week}
                critical={criticalSet.has(seg.task.id)}
                readOnly
                onEdit={onEditTask}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function PlanningBoard({ grid, tasks, backlogTasks, criticalSet, onPatchTask, onEditTask }: {
  grid: Cell[][]
  tasks: CalendarTask[]
  backlogTasks: BacklogTask[]
  criticalSet: Set<string>
  onPatchTask: (id: string, patch: Record<string, unknown>) => Promise<boolean>
  onEditTask: (task: CalendarTask) => void
}) {
  // Capture lives on the WEEKS WRAPPER (stable across re-renders) — NOT the grip, which
  // can unmount mid-drag when a bar grows into a new week. So the move/up handlers ride
  // the wrapper and keep firing even as the bars re-layout.
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; startKey: string } | null>(null)
  const [resize, setResize] = useState<{ id: string; endKey: string } | null>(null)
  const [dropHover, setDropHover] = useState<string | null>(null)

  const weeks = grid

  // The end key used for LAYOUT: the live preview while a bar is being resized, else the
  // stored end. Geometry follows the preview; lane packing (inside useSpanLayout) stays on
  // stored ends so lanes don't reshuffle mid-drag.
  const effEnd = useCallback(
    (t: CalendarTask) => (resize && resize.id === t.id ? resize.endKey : (t.end_date as string)),
    [resize],
  )

  // Same span geometry the read-only calendar uses — fed the resize-aware end here.
  const { weekSegs, WEEK_H } = useSpanLayout(weeks, tasks, effEnd)

  // Pure cell-grid hit test: which day key is under (x,y)? Uniform week height + 7 equal
  // columns → integer divide, clamp to the grid. No pixel/zoom math.
  const cellFromPoint = useCallback((clientX: number, clientY: number): string | null => {
    const el = gridRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0) return null
    let col = Math.floor(((clientX - rect.left) / rect.width) * 7)
    col = Math.max(0, Math.min(6, col))
    let wk = Math.floor((clientY - rect.top) / WEEK_H)
    wk = Math.max(0, Math.min(weeks.length - 1, wk))
    return weeks[wk][col].key
  }, [weeks, WEEK_H])

  // ── Resize (edge-drag) ─────────────────────────────────────────────────────
  const startResize = useCallback((e: React.PointerEvent, t: CalendarTask) => {
    e.preventDefault()
    e.stopPropagation()
    gridRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { id: t.id, startKey: t.start_date }
    setResize({ id: t.id, endKey: (t.end_date as string) ?? t.start_date })
  }, [])
  const moveResize = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const key = cellFromPoint(e.clientX, e.clientY)
    if (!key) return
    const endKey = key < d.startKey ? d.startKey : key // clamp end ≥ start
    setResize((r) => (r && r.id === d.id && r.endKey === endKey ? r : { id: d.id, endKey }))
  }, [cellFromPoint])
  const endResize = useCallback(async (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    const key = cellFromPoint(e.clientX, e.clientY)
    setResize(null)
    if (!key) return
    const endKey = key < d.startKey ? d.startKey : key
    const t = tasks.find((x) => x.id === d.id)
    if (t && endKey !== t.end_date) await onPatchTask(d.id, { end_date: endKey })
  }, [cellFromPoint, tasks, onPatchTask])

  // ── Drop a backlog task onto a day → schedule it ───────────────────────────
  const handleDrop = useCallback(async (cellKey: string, id: string) => {
    setDropHover(null)
    const bt = backlogTasks.find((b) => b.id === id)
    if (!bt) return
    const dur = bt.is_milestone ? 0 : (bt.duration_days ?? 0)
    // Auto-span: a real duration → end = start + (dur−1) working days; else a 1-day chip.
    const endKey = dur > 1 ? addWorkingDaysKey(cellKey, dur - 1) : cellKey
    await onPatchTask(id, { start_date: cellKey, end_date: endKey, status: "not_started" })
  }, [backlogTasks, onPatchTask])

  // ── Toggle a single day inside a bar void ──────────────────────────────────
  const toggleVoid = useCallback(async (t: CalendarTask, dayKey: string) => {
    const cur = Array.isArray(t.voided_dates) ? t.voided_dates : []
    const next = cur.includes(dayKey) ? cur.filter((d) => d !== dayKey) : [...cur, dayKey]
    await onPatchTask(t.id, { voided_dates: next })
  }, [onPatchTask])

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      {/* Calendar with spanned bars */}
      <div className="flex-1 min-w-0 w-full rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
        <div className="grid grid-cols-7 bg-[#FAFBFC] border-b border-[#E2E8F0]">
          {DOW.map((d) => (
            <div key={d} className="py-2 text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
              <span className="sm:hidden">{d[0]}</span>
              <span className="hidden sm:inline">{d}</span>
            </div>
          ))}
        </div>
        {/* Weeks wrapper = the pointer-capture + hit-test surface. */}
        <div
          ref={gridRef}
          className="relative select-none touch-none"
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDragOver={(e) => { e.preventDefault(); setDropHover(cellFromPoint(e.clientX, e.clientY)) }}
          onDragLeave={() => setDropHover(null)}
          onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); const k = cellFromPoint(e.clientX, e.clientY); setDropHover(null); if (id && k) handleDrop(k, id) }}
        >
          {weeks.map((week, wIdx) => (
            <div key={wIdx} className="relative border-b border-[#EEF1F4] last:border-b-0" style={{ height: WEEK_H }}>
              {/* Background day cells */}
              <div className="absolute inset-0 grid grid-cols-7">
                {week.map((cell) => {
                  const weekend = isWeekendKey(cell.key)
                  const over = dropHover === cell.key
                  return (
                    <div
                      key={cell.key}
                      className={`relative border-r border-[#F1F5F9] last:border-r-0 ${!cell.inMonth ? "bg-[#FAFBFC]" : weekend ? "bg-[#FBFCFD]" : "bg-white"} ${over ? "ring-2 ring-inset ring-[#7B9BB5] z-[1]" : ""}`}
                    >
                      <span
                        className={`absolute top-1 left-1.5 text-[11px] font-semibold ${
                          cell.isToday
                            ? "grid place-items-center w-5 h-5 -ml-0.5 rounded-full bg-[#7B9BB5] text-white"
                            : !cell.inMonth ? "text-[#CBD5E1]" : "text-[#475569]"
                        }`}
                      >
                        {cell.day}
                      </span>
                    </div>
                  )
                })}
              </div>
              {/* Bars overlay */}
              {weekSegs[wIdx].map((seg) => (
                <PlanBar
                  key={seg.task.id}
                  seg={seg}
                  week={week}
                  critical={criticalSet.has(seg.task.id)}
                  onToggleVoid={toggleVoid}
                  onStartResize={startResize}
                  onEdit={onEditTask}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <BacklogRail tasks={backlogTasks} />
    </div>
  )
}

// ── One spanned bar segment within a week ────────────────────────────────────
// The bar is a flex strip of per-day sub-cells; the line stays unbroken across weekends
// and voided days (voids just overlay a hatch). The head segment carries the name label.
// Two modes off ONE geometry:
//   • planning (default): each day sub-cell is a click-to-void button; the tail carries a
//     resize grip — onToggleVoid + onStartResize are wired.
//   • readOnly: the whole bar is one button that opens the editor (onEdit); voided days
//     still hatch but aren't clickable, and there is no resize grip.
function PlanBar({ seg, week, critical, readOnly = false, onToggleVoid, onStartResize, onEdit }: {
  seg: PlanSeg
  week: Cell[]
  critical: boolean
  readOnly?: boolean
  onToggleVoid?: (t: CalendarTask, dayKey: string) => void
  onStartResize?: (e: React.PointerEvent, t: CalendarTask) => void
  onEdit: (t: CalendarTask) => void
}) {
  const { task, startCol, endCol, isHead, isTail, lane } = seg
  const leftPct = (startCol / 7) * 100
  const widthPct = ((endCol - startCol + 1) / 7) * 100
  const voided = new Set(Array.isArray(task.voided_dates) ? task.voided_dates : [])
  const days: string[] = []
  for (let c = startCol; c <= endCol; c++) days.push(week[c].key)
  const bg = critical ? "#DC2626" : "#5E7E98"
  const border = critical ? "#DC2626" : "#4E6E88"
  const title = `${task.name} · ${durationLabel(task) || "task"}${voided.size ? ` · ${voided.size} day(s) voided` : ""}`
  const posStyle = { left: `${leftPct}%`, width: `${widthPct}%`, top: DAYNUM_H + lane * LANE_H, height: PLAN_BAR_H } as const

  // Milestone: a single diamond marker, no resize/void. Already a button → onEdit, so it
  // serves both modes unchanged.
  if (task.is_milestone) {
    return (
      <button
        type="button"
        title={`${task.name} · milestone`}
        onClick={() => onEdit(task)}
        className="absolute grid place-items-center"
        style={posStyle}
      >
        <span className="w-3 h-3 rotate-45 rounded-[2px] border" style={{ background: bg, borderColor: border }} />
      </button>
    )
  }

  // Per-day sub-cells (shared). The hatch overlay is identical in both modes; only whether
  // the cell is a void-toggle button (planning) or an inert span (readOnly) differs.
  const dayCells = days.map((dayKey, i) => {
    const isVoid = voided.has(dayKey)
    const cellStyle = { borderRight: i < days.length - 1 ? "1px solid rgba(255,255,255,0.18)" : "none" } as const
    const hatch = isVoid ? (
      <span
        className="absolute inset-0"
        style={{ backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 3px, rgba(255,255,255,0) 3px 6px)" }}
      />
    ) : null
    return readOnly ? (
      <span key={dayKey} className="relative flex-1 min-w-0 h-full" style={cellStyle}>{hatch}</span>
    ) : (
      <button
        key={dayKey}
        type="button"
        title={isVoid ? "Non-working day — click to restore" : "Click to mark this day non-working"}
        onClick={(e) => { e.stopPropagation(); onToggleVoid?.(task, dayKey) }}
        className="relative flex-1 min-w-0 h-full"
        style={cellStyle}
      >
        {hatch}
      </button>
    )
  })

  const barBody = (
    <div
      className="relative w-full h-full flex overflow-hidden border"
      style={{
        background: bg,
        borderColor: border,
        borderTopLeftRadius: isHead ? 4 : 0,
        borderBottomLeftRadius: isHead ? 4 : 0,
        borderTopRightRadius: isTail ? 4 : 0,
        borderBottomRightRadius: isTail ? 4 : 0,
      }}
    >
      {dayCells}
      {/* Name label rides the head segment; pointer-events-none so day clicks pass through. */}
      {isHead && (
        <span className="absolute inset-0 flex items-center pl-1.5 pr-1 pointer-events-none">
          <span className="truncate text-[10px] font-semibold text-white">{task.name}</span>
        </span>
      )}
    </div>
  )

  // Read-only: the entire bar is one button that opens the editor (matching the old chip).
  if (readOnly) {
    return (
      <button type="button" title={title} onClick={() => onEdit(task)} className="absolute block text-left" style={posStyle}>
        {barBody}
      </button>
    )
  }

  return (
    <div title={title} className="absolute" style={posStyle}>
      {barBody}
      {/* Resize grip on the tail — drag to set the finish day. */}
      {isTail && (
        <div
          onPointerDown={(e) => onStartResize?.(e, task)}
          title="Drag to set the finish date"
          className="absolute top-0 right-0 h-full w-2.5 cursor-ew-resize touch-none"
        >
          <span className="absolute inset-y-[3px] right-[2px] w-[3px] rounded bg-white/80" />
        </div>
      )}
    </div>
  )
}

// ── Backlog rail — draggable undated tasks alongside the planning calendar ────
function BacklogRail({ tasks }: { tasks: BacklogTask[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, BacklogTask[]>()
    for (const t of tasks) {
      const k = t.phase?.trim() || "Unassigned"
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(t)
    }
    return [...m.entries()]
  }, [tasks])

  return (
    <div className="w-full lg:w-72 flex-shrink-0 rounded-xl border border-[#E2E8F0] bg-white flex flex-col max-h-[70vh]">
      <div className="px-4 py-3 border-b border-[#E2E8F0] flex-shrink-0">
        <h3 className="text-[13px] font-bold text-[#0F172A]">Backlog</h3>
        <p className="text-[11px] text-[#64748B] mt-0.5">
          {tasks.length === 0 ? "Nothing unscheduled." : `Drag a task onto a day to schedule it (${tasks.length}).`}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-[#94A3B8]">No backlog tasks — everything has dates.</p>
        ) : (
          groups.map(([phase, list]) => (
            <div key={phase}>
              <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-[#F4F7FA] border-b border-[#E2E8F0]">
                <span className="text-[10px] font-bold uppercase tracking-wide text-[#475569] truncate">{phase}</span>
                <span className="text-[10px] text-[#94A3B8]">{list.length}</span>
              </div>
              <ul>
                {list.map((t) => (
                  <li key={t.id} className="px-3 py-2 border-b border-[#F1F5F9]">
                    <div
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move" }}
                      title={`${t.name} — drag onto a day`}
                      className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-2 cursor-grab active:cursor-grabbing hover:bg-[#EEF2F6] transition-colors"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {t.is_milestone && <span className="w-2 h-2 rotate-45 flex-shrink-0 bg-[#475569]" />}
                        <span className="truncate text-[12px] font-medium text-[#0F172A]">{t.name}</span>
                      </div>
                      <p className="text-[10px] text-[#64748B] mt-0.5">
                        {t.is_milestone ? "Milestone" : durationLabel(t) || "Task"}
                        {t.crew_size != null && <> · crew {t.crew_size}</>}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
