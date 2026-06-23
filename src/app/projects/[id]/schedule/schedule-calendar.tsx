"use client"

import { useMemo, useState } from "react"

// ── Schedule month-calendar view (ADR-011 / ADR-012) ─────────────────────────
// A read-only month-grid rendering of the SAME schedule_tasks the Gantt loads —
// it takes the parent's already-fetched `tasks` as a prop, so there is NO new
// fetch, route, or schema. The point is parity with the THP PM's hand-built
// Bluebeam lookahead: a 7-col Sun–Sat month grid with each task as a chip in its
// START-day cell labeled "{name}, {N} day(s)" (NOT spanned across cells — the
// source shows a task on one day with a duration label).
//
// Visual language mirrors <ManpowerCalendar> (PR #42) — same month chrome,
// weekday row, day-number cells, and chip styling — so the two calendars read the
// same. It isn't the shared component (that one is welded to the assignments API
// with its own fetch + form modals); the grid skeleton is mirrored here instead.
//
// Multi-month jobs page ONE MONTH AT A TIME (matching the multi-page source PDF):
// the pager steps through only the months that actually contain tasks. Critical
// tasks (criticalSet, from the same CPM overlay the Gantt uses) are red, so the
// two views agree. Clicking a chip opens the existing task editor.

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

export default function ScheduleCalendar({
  tasks, criticalSet, onEditTask,
}: {
  tasks: CalendarTask[]
  criticalSet: Set<string>
  onEditTask: (task: CalendarTask) => void
}) {
  const tKey = useMemo(() => todayKey(), [])

  // The months that actually contain tasks (by start day), ascending. One of these
  // is shown at a time — matching how the PM's multi-page calendar reads.
  const months = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) if (t.start_date) set.add(monthKeyOf(t.start_date))
    return [...set].sort()
  }, [tasks])

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

  // Index tasks by their start-day cell (string match — both are YYYY-MM-DD).
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarTask[]>()
    for (const t of tasks) {
      if (!t.start_date) continue
      const arr = map.get(t.start_date) ?? []
      arr.push(t)
      map.set(t.start_date, arr)
    }
    return map
  }, [tasks])

  const grid = useMemo(() => buildMonthGrid(year, month0, tKey), [year, month0, tKey])
  const monthCount = useMemo(
    () => tasks.filter((t) => t.start_date && monthKeyOf(t.start_date) === current).length,
    [tasks, current],
  )

  const canPrev = idx > 0
  const canNext = idx >= 0 && idx < months.length - 1

  return (
    <div>
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
