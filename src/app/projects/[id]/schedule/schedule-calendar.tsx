"use client"

import { useCallback, useMemo, useState } from "react"

// ── Schedule month-calendar view (ADR-011 / ADR-012) ─────────────────────────
// A read-only month-grid rendering of the SAME schedule_tasks the Gantt loads —
// it takes the parent's already-fetched `tasks` as a prop, so there is NO new
// fetch, route, or schema. The point is parity with the THP PM's hand-built
// Bluebeam lookahead: a 7-col Sun–Sat month grid with each task as a chip in its
// START-day cell labeled "{name}, {N} day(s)" (NOT spanned across cells — the
// source shows a task on one day with a duration label).
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
// so the two views agree. Clicking a chip opens the existing task editor.

interface CalendarTask {
  id: string
  name: string
  start_date: string // YYYY-MM-DD (stored date — the chip's day; NOT the CPM overlay)
  duration_days: number
  is_milestone: boolean
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

const durationLabel = (t: CalendarTask) =>
  t.is_milestone || t.duration_days === 0 ? "milestone" : `${t.duration_days} day${t.duration_days === 1 ? "" : "s"}`

// Filename-safe slug of the project name for the downloaded PDF.
const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"

export default function ScheduleCalendar({
  tasks, criticalSet, onEditTask, projectId, projectName,
}: {
  tasks: CalendarTask[]
  criticalSet: Set<string>
  onEditTask: (task: CalendarTask) => void
  projectId: string
  projectName: string
}) {
  const tKey = useMemo(() => todayKey(), [])

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

  // The months that actually contain SHOWN tasks (by start day), ascending. One of
  // these is shown at a time — matching how the PM's multi-page calendar reads.
  const months = useMemo(() => {
    const set = new Set<string>()
    for (const t of shownTasks) if (t.start_date) set.add(monthKeyOf(t.start_date))
    return [...set].sort()
  }, [shownTasks])

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

  // Index SHOWN tasks by their start-day cell (string match — both are YYYY-MM-DD).
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarTask[]>()
    for (const t of shownTasks) {
      if (!t.start_date) continue
      const arr = map.get(t.start_date) ?? []
      arr.push(t)
      map.set(t.start_date, arr)
    }
    return map
  }, [shownTasks])

  const grid = useMemo(() => buildMonthGrid(year, month0, tKey), [year, month0, tKey])
  const monthCount = useMemo(
    () => shownTasks.filter((t) => t.start_date && monthKeyOf(t.start_date) === current).length,
    [shownTasks, current],
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
      {/* ── Scope panel: keyword filter + per-task checkboxes + Export ─────────── */}
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

      {/* The month grid — always rendered (it IS the empty state). */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
        <div className="grid grid-cols-7 bg-[#FAFBFC] border-b border-[#E2E8F0]">
          {DOW.map((d) => (
            <div key={d} className="py-2 text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
              <span className="sm:hidden">{d[0]}</span>
              <span className="hidden sm:inline">{d}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px bg-[#EEF1F4]">
          {grid.flat().map((cell) => {
            if (!cell.inMonth) {
              return (
                <div key={cell.key} className="min-w-0 min-h-[88px] sm:min-h-[120px] bg-[#FAFBFC] p-1.5 sm:p-2">
                  <span className="text-[12px] font-medium text-[#CBD5E1]">{cell.day}</span>
                </div>
              )
            }
            const dayTasks = byDay.get(cell.key) ?? []
            return (
              <div
                key={cell.key}
                className={`flex flex-col gap-1 min-w-0 min-h-[88px] sm:min-h-[120px] p-1.5 sm:p-2 ${cell.isToday ? "bg-[#F5F9FC]" : "bg-white"}`}
              >
                <span className="flex items-center">
                  {cell.isToday ? (
                    <span className="grid place-items-center w-6 h-6 rounded-full bg-[#7B9BB5] text-white text-[12px] font-bold">{cell.day}</span>
                  ) : (
                    <span className="text-[12px] font-semibold text-[#475569] px-1">{cell.day}</span>
                  )}
                </span>
                {/* All tasks for the day stack here; the row grows to fit (no truncation). */}
                <span className="flex flex-col gap-1 min-w-0">
                  {dayTasks.map((t) => (
                    <TaskChip key={t.id} task={t} critical={criticalSet.has(t.id)} onClick={() => onEditTask(t)} />
                  ))}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── One task chip inside a day cell ──────────────────────────────────────────
// Mirrors the source's "{name}, {N} day(s)". Critical = red (agrees with the
// Gantt); milestones lead with a diamond. Text wraps so the full label is visible.
function TaskChip({ task, critical, onClick }: { task: CalendarTask; critical: boolean; onClick: () => void }) {
  const label = `${task.name}, ${durationLabel(task)}`
  const cls = critical
    ? "bg-red-50 border-red-300 text-red-700 hover:bg-red-100"
    : "bg-[#EEF2F6] border-[#CBD5E1] text-[#334155] hover:bg-[#E2EAF1]"
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`flex items-start gap-1 w-full text-left rounded px-1.5 py-1 text-[11px] leading-tight border transition-colors ${cls}`}
    >
      {task.is_milestone && (
        <span className={`mt-[3px] w-2 h-2 rotate-45 flex-shrink-0 ${critical ? "bg-red-600" : "bg-[#475569]"}`} title="Milestone" />
      )}
      <span className="min-w-0 break-words">{label}</span>
    </button>
  )
}
