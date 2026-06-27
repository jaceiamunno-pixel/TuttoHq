"use client"

import { apiFetch } from "@/lib/api-client"
import { useCallback, useEffect, useMemo, useState } from "react"

// ── Manpower month calendar (Phase 4) ───────────────────────────────────────
// One shared month-grid component for BOTH manpower surfaces:
//   • Per-project tab  → <ManpowerCalendar projectId={id} />   (project implied)
//   • Company-wide tab → <ManpowerCalendar />                   ("everyone everywhere")
// Both read the SAME RLS-scoped GET /api/manpower-assignments (?project_id,&from,&to):
// with a projectId the read is pinned to that one project; without it the company
// RLS scope alone backs the everyone-everywhere view. Writes go through the same
// /api/manpower-assignments[/id] routes the Phase-3 list used — this is a pure-UI
// re-skin of that write-layer onto a literal month grid; the API is untouched.
//
// Double-booking is allowed, never blocked: the API returns { conflict: true } and
// we badge it with an amber dot. The grid IS the empty state — an empty month
// still renders the full grid, never a "no assignments" card.

type AssigneeType = "worker" | "vendor"
type Status = "planned" | "actual"

interface Assignment {
  id: string
  project_id: string
  assignee_type: AssigneeType
  worker_id: string | null
  vendor_id: string | null
  work_date: string
  start_time: string | null
  end_time: string | null
  status: Status
  crew_size: number | null
  description: string | null
  notes: string | null
  worker: { id: string; full_name: string; trade: string | null } | null
  vendor: { id: string; company_name: string } | null
}

interface Worker { id: string; full_name: string; trade: string | null; active: boolean }
interface SubVendor { id: string; company_name: string }
interface ProjectLite { id: string; name: string }

// ── Date / time helpers (parse from parts to dodge UTC-midnight shifts) ──────
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}
function monthRange(year: number, month0: number): { from: string; to: string } {
  return { from: ymd(new Date(year, month0, 1)), to: ymd(new Date(year, month0 + 1, 0)) }
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
function dateHeader(s: string): string {
  const d = parseYmd(s)
  return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`
}
function fmtTime(t: string | null): string | null {
  if (!t) return null
  const [hh, mm] = t.slice(0, 5).split(":").map(Number)
  const ap = hh < 12 ? "AM" : "PM"
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:${String(mm).padStart(2, "0")} ${ap}`
}
function timeRange(a: Assignment): string | null {
  const s = fmtTime(a.start_time), e = fmtTime(a.end_time)
  if (s && e) return `${s}–${e}`
  if (s) return `from ${s}`
  if (e) return `until ${e}`
  return null
}

// One grid cell. `inMonth` distinguishes the visible month's days from the dimmed
// lead/trailing fill of adjacent months (those carry no data — the fetch window is
// this month only — so they're display-only, not clickable).
interface Cell { key: string; day: number; inMonth: boolean; isToday: boolean }

// Build the visible month as 7-wide week rows. Lead days back-fill from the prior
// month so week 1 starts on Sunday; trailing days fill week N out to Saturday.
// Week count is the natural ceil (5 for most months, 6 when the month spills).
function buildMonthGrid(year: number, month0: number, todayKey: string): Cell[][] {
  const startDow = new Date(year, month0, 1).getDay() // 0 = Sun
  const daysInMonth = new Date(year, month0 + 1, 0).getDate()
  const weeks = Math.ceil((startDow + daysInMonth) / 7)
  const first = new Date(year, month0, 1 - startDow) // first cell (may be prev month)
  const cells: Cell[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)
    const key = ymd(d)
    cells.push({ key, day: d.getDate(), inMonth: d.getMonth() === month0, isToday: key === todayKey })
  }
  const rows: Cell[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

// ── Conflict detection (mirrors the API's blocksOverlap, for the loaded window) ─
// Badges same-worker / same-day overlaps among the rows currently on screen.
// Company-wide this naturally catches cross-project double-books too. The API's
// write-time probe (conflictIds) is authoritative; this just covers rows we never
// re-saved this session.
function hhmm(t: string | null): string | null { return t ? t.slice(0, 5) : null }
function overlaps(aS: string | null, aE: string | null, bS: string | null, bE: string | null): boolean {
  const as = hhmm(aS), ae = hhmm(aE), bs = hhmm(bS), be = hhmm(bE)
  if (!as || !ae || !bs || !be) return true
  return as < be && ae > bs
}
function computeLocalConflicts(rows: Assignment[]): Set<string> {
  const out = new Set<string>()
  const byWorkerDay = new Map<string, Assignment[]>()
  for (const a of rows) {
    if (a.assignee_type !== "worker" || !a.worker_id) continue
    const key = `${a.worker_id}|${a.work_date}`
    const arr = byWorkerDay.get(key) ?? []
    arr.push(a)
    byWorkerDay.set(key, arr)
  }
  for (const arr of byWorkerDay.values()) {
    if (arr.length < 2) continue
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (overlaps(arr[i].start_time, arr[i].end_time, arr[j].start_time, arr[j].end_time)) {
          out.add(arr[i].id); out.add(arr[j].id)
        }
      }
    }
  }
  return out
}

const VISIBLE_CHIPS = 3
const now = () => new Date()

export default function ManpowerCalendar({ projectId }: { projectId?: string }) {
  // No projectId → company-wide "everyone everywhere" view (chips carry the project).
  const companyWide = !projectId

  const today = now()
  const [year, setYear] = useState(today.getFullYear())
  const [month0, setMonth0] = useState(today.getMonth())
  const todayKey = useMemo(() => ymd(now()), [])

  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [projects, setProjects] = useState<ProjectLite[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Conflicts flagged by the API at write time (authoritative, cross-project).
  const [conflictIds, setConflictIds] = useState<Set<string>>(new Set())
  // In-session "Recently deleted" buffer (no list-deleted RPC exists, so this only
  // holds rows soft-deleted during this visit and offers Restore; reload clears it).
  const [recentlyDeleted, setRecentlyDeleted] = useState<Assignment[]>([])

  // PLANNED crew demand for the visible month (ADR-014 overlay): a YYYY-MM-DD → demand
  // map from the crew-demand route. Per-project → that project's demand; company-wide →
  // demand summed across ALL the caller's projects (Phase 2). Best-effort: a failed fetch
  // leaves it empty and never blocks the grid — this is a soft overlay, not the booking path.
  const [demand, setDemand] = useState<Record<string, number>>({})

  const [dayDetail, setDayDetail] = useState<string | null>(null) // open day's YYYY-MM-DD
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Assignment | null>(null)
  const [formDate, setFormDate] = useState<string | null>(null)

  const { from, to } = useMemo(() => monthRange(year, month0), [year, month0])

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    const scope = projectId ? `project_id=${projectId}&` : ""
    apiFetch(`/api/manpower-assignments?${scope}from=${from}&to=${to}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to load")
        return r.json()
      })
      .then(d => setAssignments(d.assignments ?? []))
      .catch(e => setLoadError(e.message ?? "Failed to load assignments"))
      .finally(() => setLoading(false))
  }, [projectId, from, to])

  useEffect(load, [load])

  // Company roster for the picker (loaded once; all workers, RLS company-scoped).
  useEffect(() => {
    apiFetch("/api/workers")
      .then(r => r.json())
      .then(d => setWorkers(d.workers ?? []))
      .catch(() => {})
  }, [])

  // Company projects — needed company-wide for the "→ project" chip label and the
  // create-form project picker (per-project mode already knows its project).
  useEffect(() => {
    if (!companyWide) return
    apiFetch("/api/projects")
      .then(r => r.json())
      .then(d => setProjects((d.projects ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))))
      .catch(() => {})
  }, [companyWide])

  // Planned crew-demand overlay — same window the assignments use, in BOTH modes.
  // Per-project → that project's demand (?project_id); company-wide → demand summed across
  // all the caller's projects (no project_id, Phase 2). Re-fetches on project + month
  // change. The demand math lives entirely in the route; we just render plan vs booked.
  useEffect(() => {
    const ctrl = new AbortController()
    const scope = projectId ? `project_id=${projectId}&` : ""
    apiFetch(`/api/schedule-tasks/crew-demand?${scope}from=${from}&to=${to}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : { demand: {} }))
      .then(d => setDemand(d.demand ?? {}))
      .catch(() => {}) // overlay is best-effort; never surface its failure on the grid
    return () => ctrl.abort()
  }, [projectId, from, to])

  const projectName = useCallback(
    (id: string) => projects.find(p => p.id === id)?.name ?? "Project",
    [projects],
  )

  const localConflicts = useMemo(() => computeLocalConflicts(assignments), [assignments])
  const isConflicted = useCallback(
    (id: string) => conflictIds.has(id) || localConflicts.has(id),
    [conflictIds, localConflicts],
  )

  // Index assignments by their work_date for O(1) per-cell lookup.
  const byDate = useMemo(() => {
    const map = new Map<string, Assignment[]>()
    for (const a of assignments) {
      const arr = map.get(a.work_date) ?? []
      arr.push(a)
      map.set(a.work_date, arr)
    }
    return map
  }, [assignments])

  // BOOKED head-count per day for the demand-vs-booked gap (per-project view). A worker
  // row counts 1; a vendor crew counts COALESCE(crew_size,1). The per-project read is
  // already pinned to this project, so summing the loaded rows is this project's booked.
  const bookedByDate = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of assignments) {
      const n = a.assignee_type === "vendor" ? (a.crew_size ?? 1) : 1
      map.set(a.work_date, (map.get(a.work_date) ?? 0) + n)
    }
    return map
  }, [assignments])

  const grid = useMemo(() => buildMonthGrid(year, month0, todayKey), [year, month0, todayKey])

  function prevMonth() {
    if (month0 === 0) { setMonth0(11); setYear(y => y - 1) } else setMonth0(m => m - 1)
  }
  function nextMonth() {
    if (month0 === 11) { setMonth0(0); setYear(y => y + 1) } else setMonth0(m => m + 1)
  }
  function goToday() { const t = now(); setYear(t.getFullYear()); setMonth0(t.getMonth()) }

  function openCreate(date?: string) {
    setEditing(null)
    setFormDate(date ?? ymd(now()))
    setFormOpen(true)
  }
  function openEdit(a: Assignment) {
    setEditing(a)
    setFormDate(null)
    setFormOpen(true)
  }

  function onSaved(saved: Assignment, conflict: boolean, mode: "add" | "edit") {
    setFormOpen(false)
    setConflictIds(prev => {
      const nextSet = new Set(prev)
      if (conflict) nextSet.add(saved.id); else nextSet.delete(saved.id)
      return nextSet
    })
    // A saved row may now fall outside the visible window (date changed) — drop it
    // from the grid in that case; the day-detail (if open) re-reads from `byDate`.
    const inWindow = saved.work_date >= from && saved.work_date <= to
    if (mode === "edit") {
      setAssignments(rows => inWindow ? rows.map(r => (r.id === saved.id ? saved : r)) : rows.filter(r => r.id !== saved.id))
    } else if (inWindow) {
      setAssignments(rows => [...rows, saved])
    }
  }

  async function remove(a: Assignment) {
    if (!confirm(`Remove this ${a.assignee_type === "worker" ? "worker" : "crew"} assignment? It can be restored this session.`)) return
    const res = await apiFetch(`/api/manpower-assignments/${a.id}`, { method: "DELETE" })
    if (res.ok) {
      setAssignments(rows => rows.filter(r => r.id !== a.id))
      setRecentlyDeleted(rd => [a, ...rd.filter(r => r.id !== a.id)])
    } else {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to remove assignment")
    }
  }

  async function restore(a: Assignment) {
    const res = await apiFetch(`/api/manpower-assignments/${a.id}/restore`, { method: "POST" })
    if (res.ok) {
      setRecentlyDeleted(rd => rd.filter(r => r.id !== a.id))
      load()
    } else {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to restore assignment")
    }
  }

  const total = assignments.length
  const dayAssignments = dayDetail ? (byDate.get(dayDetail) ?? []) : []

  return (
    <div>
      {/* Month chrome: ◀ Month Year ▶ · Today · Add assignment */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1.5">
          <button onClick={prevMonth} aria-label="Previous month" className="h-8 w-8 grid place-items-center rounded-md border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC]">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <span className="text-[14px] font-semibold text-[#0F172A] min-w-[132px] text-center">{MONTHS[month0]} {year}</span>
          <button onClick={nextMonth} aria-label="Next month" className="h-8 w-8 grid place-items-center rounded-md border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC]">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          <button onClick={goToday} className="ml-1 h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#475569] hover:bg-[#F8FAFC]">Today</button>
        </div>
        <div className="flex items-center gap-3">
          {!loading && !loadError && (
            <span className="text-[12px] text-[#64748B] hidden sm:inline">{total} assignment{total === 1 ? "" : "s"}</span>
          )}
          <button
            onClick={() => openCreate()}
            className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors whitespace-nowrap"
          >
            Add assignment
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-white rounded-xl border border-red-200 px-6 py-6 text-center mb-4">
          <p className="text-[13px] text-red-600">{loadError}</p>
          <button onClick={load} className="mt-3 h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Retry</button>
        </div>
      )}

      {/* The month grid — always rendered (it IS the empty state). While the month
          fetch is in flight the cells show skeleton bars instead of chips. */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
        <div className="grid grid-cols-7 bg-[#FAFBFC] border-b border-[#E2E8F0]">
          {DOW.map(d => (
            <div key={d} className="py-2 text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
              <span className="sm:hidden">{d[0]}</span>
              <span className="hidden sm:inline">{d}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px bg-[#EEF1F4]">
          {grid.flat().map(cell => {
            if (!cell.inMonth) {
              return (
                <div key={cell.key} className="min-w-0 min-h-[84px] sm:min-h-[116px] bg-[#FAFBFC] p-1.5 sm:p-2">
                  <span className="text-[12px] font-medium text-[#CBD5E1]">{cell.day}</span>
                </div>
              )
            }
            const rows = byDate.get(cell.key) ?? []
            const shown = rows.slice(0, VISIBLE_CHIPS)
            const extra = rows.length - shown.length
            // Planned demand vs booked for the soft staffing-gap overlay. In company-wide
            // mode both are company totals (demand summed across projects; booked = all rows).
            const demandN = demand[cell.key] ?? 0
            const bookedN = bookedByDate.get(cell.key) ?? 0
            return (
              <button
                key={cell.key}
                type="button"
                onClick={() => setDayDetail(cell.key)}
                className={`text-left flex flex-col gap-1 min-w-0 min-h-[84px] sm:min-h-[116px] p-1.5 sm:p-2 transition-colors hover:bg-[#F4F8FB] ${cell.isToday ? "bg-[#F5F9FC]" : "bg-white"}`}
              >
                <span className="flex items-center justify-between gap-1 min-w-0">
                  {cell.isToday ? (
                    <span className="grid place-items-center w-6 h-6 rounded-full bg-[#7B9BB5] text-white text-[12px] font-bold flex-shrink-0">{cell.day}</span>
                  ) : (
                    <span className="text-[12px] font-semibold text-[#475569] px-1 flex-shrink-0">{cell.day}</span>
                  )}
                  {!loading && <DemandIndicator demand={demandN} booked={bookedN} />}
                </span>
                <span className="flex flex-col gap-0.5 min-w-0">
                  {loading ? (
                    <>
                      <span className="block h-3.5 rounded bg-[#EEF1F4] animate-pulse" />
                      <span className="block h-3.5 rounded bg-[#EEF1F4] animate-pulse w-2/3" />
                    </>
                  ) : (
                    <>
                      {shown.map(a => (
                        <Chip
                          key={a.id}
                          a={a}
                          companyWide={companyWide}
                          projectName={projectName}
                          conflict={isConflicted(a.id)}
                        />
                      ))}
                      {extra > 0 && (
                        <span className="text-[10px] font-semibold text-[#64748B] px-1">+{extra} more</span>
                      )}
                    </>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {recentlyDeleted.length > 0 && (
        <div className="mt-6 bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#FAFBFC]">
            <p className="text-[12px] font-semibold text-[#0F172A]">Recently deleted <span className="font-normal text-[#94A3B8]">(this session)</span></p>
          </div>
          <ul>
            {recentlyDeleted.map(a => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#F1F5F9] last:border-0">
                <span className="text-[13px] text-[#64748B] truncate">
                  {assigneeLabel(a)} · {dateHeader(a.work_date)}{companyWide ? ` · ${projectName(a.project_id)}` : ""}
                </span>
                <button onClick={() => restore(a)} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] whitespace-nowrap">Restore</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Day detail — the visible month's assignments for one day, with edit/delete
          and a date-prefilled "+ Add assignment". Reads live from `byDate`, so it
          re-renders as adds/edits/deletes land. */}
      {dayDetail && (
        <DayDetailModal
          date={dayDetail}
          rows={dayAssignments}
          companyWide={companyWide}
          projectName={projectName}
          isConflicted={isConflicted}
          demand={demand[dayDetail] ?? 0}
          booked={bookedByDate.get(dayDetail) ?? 0}
          onClose={() => setDayDetail(null)}
          onAdd={() => openCreate(dayDetail)}
          onEdit={openEdit}
          onRemove={remove}
        />
      )}

      {formOpen && (
        <AssignmentFormModal
          projectId={projectId}
          projects={projects}
          projectName={projectName}
          workers={workers}
          assignment={editing}
          defaultDate={formDate ?? ymd(now())}
          onClose={() => setFormOpen(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

// ── Chip — one assignment inside a day cell ──────────────────────────────────
// Planned = outlined, Actual = filled (the spec's visual distinction). Conflict
// rows carry a leading amber dot. Vendor crews of >1 show a crew-size badge.
function Chip({ a, companyWide, projectName, conflict }: {
  a: Assignment
  companyWide: boolean
  projectName: (id: string) => string
  conflict: boolean
}) {
  const planned = a.status === "planned"
  const name = a.assignee_type === "vendor"
    ? (a.vendor?.company_name ?? "Crew")
    : (a.worker?.full_name ?? "Worker")
  const tr = timeRange(a)
  const suffix = companyWide ? ` → ${projectName(a.project_id)}` : (tr ? ` · ${tr}` : "")
  const crew = a.assignee_type === "vendor" && (a.crew_size ?? 0) > 1 ? a.crew_size : null
  return (
    <span
      title={`${name}${suffix}`}
      className={`flex items-center gap-1 min-w-0 rounded px-1.5 py-0.5 text-[11px] leading-tight border ${planned ? "bg-white border-[#CBD5E1] text-[#334155]" : "bg-[#7B9BB5] border-[#7B9BB5] text-white"}`}
    >
      {conflict && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" title="Double-booked" />}
      <span className="truncate flex-1 min-w-0">{name}{suffix}</span>
      {crew && (
        <span className={`flex-shrink-0 rounded px-1 text-[10px] font-bold ${planned ? "bg-[#EEF2F6] text-[#456A88]" : "bg-white/25 text-white"}`}>{crew}</span>
      )}
    </span>
  )
}

// ── Day detail modal ─────────────────────────────────────────────────────────
function DayDetailModal({ date, rows, companyWide, projectName, isConflicted, demand, booked, onClose, onAdd, onEdit, onRemove }: {
  date: string
  rows: Assignment[]
  companyWide: boolean
  projectName: (id: string) => string
  isConflicted: (id: string) => boolean
  demand: number
  booked: number
  onClose: () => void
  onAdd: () => void
  onEdit: (a: Assignment) => void
  onRemove: (a: Assignment) => void
}) {
  const gap = demand - booked
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl border border-[#E2E8F0] shadow-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0]">
          <h2 className="text-[15px] font-bold text-[#0F172A]">{dateHeader(date)}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Staffing summary — planned crew (schedule) vs booked (manpower) for this day,
            with the soft gap badge. Understaffed offers a Revise shortcut into the same
            add-assignment flow; nothing is blocked or auto-created. Shown in BOTH modes:
            per-project these are that project's totals, company-wide they're summed across
            all projects (the assignment list below names each row's project). Hidden when
            there's no planned demand for the day. */}
        {demand > 0 && (
          <div className="px-5 py-2.5 border-b border-[#E2E8F0] bg-[#FAFBFC] flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="text-[12px] text-[#475569]">
                Planned crew <span className="font-semibold text-[#0F172A]">{demand}</span>
                {" · "}Booked <span className="font-semibold text-[#0F172A]">{booked}</span>
              </span>
              <GapBadge gap={gap} />
            </div>
            {gap > 0 && (
              <button
                onClick={onAdd}
                className="h-7 px-2.5 rounded-md border border-amber-300 bg-white text-[12px] font-semibold text-amber-700 hover:bg-amber-50 whitespace-nowrap"
              >
                Revise
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-[#64748B]">No assignments on this day yet.</p>
          ) : (
            <ul>
              {rows.map(a => {
                const tr = timeRange(a)
                return (
                  <li key={a.id} className="flex items-start justify-between gap-3 px-5 py-3 border-b border-[#F1F5F9] last:border-0">
                    <div className="min-w-0">
                      <div className="flex items-center flex-wrap gap-2">
                        <span className="text-[13px] font-semibold text-[#0F172A]">{assigneeLabel(a)}</span>
                        <StatusBadge status={a.status} />
                        {isConflicted(a.id) && (
                          <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5" title="This worker has another overlapping assignment that day">
                            Double-booked
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] text-[#64748B] mt-0.5">
                        {companyWide ? projectName(a.project_id) : (tr ?? "All day")}
                        {companyWide && tr ? ` · ${tr}` : ""}
                        {a.assignee_type === "vendor" && a.crew_size ? ` · crew of ${a.crew_size}` : ""}
                        {a.description ? ` · ${a.description}` : ""}
                      </p>
                    </div>
                    <div className="flex-shrink-0 whitespace-nowrap">
                      <button onClick={() => onEdit(a)} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] mr-3">Edit</button>
                      <button onClick={() => onRemove(a)} className="text-[12px] font-semibold text-red-500 hover:text-red-600">Remove</button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end px-5 py-3.5 border-t border-[#E2E8F0]">
          <button onClick={onAdd} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">+ Add assignment</button>
        </div>
      </div>
    </div>
  )
}

function assigneeLabel(a: Assignment): string {
  if (a.assignee_type === "vendor") {
    return a.vendor?.company_name ?? "Subcontractor crew"
  }
  const name = a.worker?.full_name ?? "Worker"
  const trade = a.worker?.trade
  return trade ? `${name} · ${trade}` : name
}

function StatusBadge({ status }: { status: Status }) {
  const planned = status === "planned"
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 border ${planned ? "text-slate-600 bg-slate-100 border-slate-200" : "text-emerald-700 bg-emerald-100 border-emerald-200"}`}>
      {planned ? "Planned" : "Actual"}
    </span>
  )
}

// ── Staffing-gap overlay (ADR-014) ───────────────────────────────────────────
// gap = planned demand − booked. UNDERSTAFFED (gap > 0, booked below plan) is the
// actionable amber case; OVER-PLAN (gap < 0) is informational grey. This is a SOFT
// signal — it never blocks a booking, never auto-creates a row, never edits a task.
function GapBadge({ gap, compact = false }: { gap: number; compact?: boolean }) {
  if (gap === 0) return null
  const under = gap > 0
  const n = Math.abs(gap)
  const label = compact ? (under ? `−${n}` : `+${n}`) : (under ? `Understaffed −${n}` : `Over plan +${n}`)
  return (
    <span
      title={under ? `Booked is ${n} below the planned crew for this day` : `Booked is ${n} above the planned crew for this day`}
      className={`rounded font-bold uppercase tracking-wide leading-none whitespace-nowrap border ${compact ? "px-1 py-0.5 text-[9px] sm:text-[10px]" : "px-1.5 py-0.5 text-[10px]"} ${
        under ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-500 border-slate-200"
      }`}
    >
      {label}
    </span>
  )
}

// In-cell plan-vs-booked underlay: a subtle "plan: N" label plus the compact gap chip.
// Non-interactive (the day cell is itself the button → day detail, where the actionable
// Revise lives). Renders nothing on days with no planned demand, so unscheduled days stay
// quiet and the overlay only speaks where the schedule actually projects crew.
function DemandIndicator({ demand, booked }: { demand: number; booked: number }) {
  if (demand <= 0) return null
  return (
    <span className="flex items-center gap-1 min-w-0">
      <span
        className="text-[9px] sm:text-[10px] font-medium text-[#94A3B8] leading-none whitespace-nowrap"
        title={`Planned crew demand ${demand} · booked ${booked}`}
      >
        plan: {demand}
      </span>
      <GapBadge gap={demand - booked} compact />
    </span>
  )
}

// ── Create / edit modal ──────────────────────────────────────────────────────
const inputCls = "w-full h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"

function AssignmentFormModal({ projectId, projects, projectName, workers, assignment, defaultDate, onClose, onSaved }: {
  projectId?: string
  projects: ProjectLite[]
  projectName: (id: string) => string
  workers: Worker[]
  assignment: Assignment | null
  defaultDate: string
  onClose: () => void
  onSaved: (saved: Assignment, conflict: boolean, mode: "add" | "edit") => void
}) {
  const isEdit = !!assignment
  // Per-project mode pins the project; company-wide create lets the user pick one
  // (the API requires project_id on create). PATCH can't move an assignment between
  // projects, so company-wide EDIT shows the project read-only.
  const fixedProject = !!projectId
  const [projId, setProjId] = useState(assignment?.project_id ?? projectId ?? "")

  const [assigneeType, setAssigneeType] = useState<AssigneeType>(assignment?.assignee_type ?? "worker")
  const [workerId, setWorkerId] = useState(assignment?.worker_id ?? "")
  const [vendorId, setVendorId] = useState(assignment?.vendor_id ?? "")
  const [workDate, setWorkDate] = useState(assignment?.work_date ?? defaultDate)
  const [startTime, setStartTime] = useState(assignment?.start_time?.slice(0, 5) ?? "")
  const [endTime, setEndTime] = useState(assignment?.end_time?.slice(0, 5) ?? "")
  const [status, setStatus] = useState<Status>(assignment?.status ?? "planned")
  const [crewSize, setCrewSize] = useState(assignment?.crew_size ? String(assignment.crew_size) : "")
  const [description, setDescription] = useState(assignment?.description ?? "")

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Subcontractor picker: server-searched against the unified vendors master
  // (role=subcontractor, RLS company-scoped, capped at 50 — refine via search).
  const [subQuery, setSubQuery] = useState("")
  const [subs, setSubs] = useState<SubVendor[]>([])
  useEffect(() => {
    const ctrl = new AbortController()
    const url = `/api/vendors?role=subcontractor${subQuery.trim() ? `&q=${encodeURIComponent(subQuery.trim())}` : ""}`
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => setSubs((d.vendors ?? []).map((v: { id: string; company_name: string }) => ({ id: v.id, company_name: v.company_name }))))
      .catch(() => {})
    return () => ctrl.abort()
  }, [subQuery])

  // If editing a vendor assignment, make sure its current sub appears in the list
  // even before any search (so the <select> shows the right name).
  const subOptions = useMemo(() => {
    const list = [...subs]
    if (assignment?.vendor && !list.some(s => s.id === assignment.vendor!.id)) {
      list.unshift({ id: assignment.vendor.id, company_name: assignment.vendor.company_name })
    }
    return list
  }, [subs, assignment])

  const sortedWorkers = useMemo(
    () => [...workers].sort((a, b) => Number(b.active) - Number(a.active) || a.full_name.localeCompare(b.full_name)),
    [workers],
  )

  async function save() {
    setErr(null)
    const effectiveProjectId = fixedProject ? projectId! : projId
    if (!isEdit && !effectiveProjectId) { setErr("Pick a project."); return }
    if (!workDate) { setErr("Pick a date."); return }
    if (assigneeType === "worker" && !workerId) { setErr("Pick a worker."); return }
    if (assigneeType === "vendor" && !vendorId) { setErr("Pick a subcontractor."); return }
    if (startTime && endTime && startTime >= endTime) { setErr("End time must be after start time."); return }

    setSaving(true)
    const base = {
      assignee_type: assigneeType,
      worker_id: assigneeType === "worker" ? workerId : null,
      vendor_id: assigneeType === "vendor" ? vendorId : null,
      work_date: workDate,
      start_time: startTime || null,
      end_time: endTime || null,
      status,
      crew_size: assigneeType === "vendor" && crewSize.trim() ? Number(crewSize) : null,
      description: description.trim() || null,
    }
    // PATCH never carries project_id (the API can't move an assignment between
    // projects); create sends the pinned / picked project.
    const res = isEdit
      ? await apiFetch(`/api/manpower-assignments/${assignment!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(base) })
      : await apiFetch(`/api/manpower-assignments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: effectiveProjectId, ...base }) })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved(d.assignment as Assignment, !!d.conflict, isEdit ? "edit" : "add")
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl border border-[#E2E8F0] shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0] sticky top-0 bg-white">
          <h2 className="text-[15px] font-bold text-[#0F172A]">{isEdit ? "Edit assignment" : "Add assignment"}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* Project — company-wide only (per-project pins it). Read-only on edit. */}
          {!fixedProject && (
            isEdit ? (
              <Field label="Project">
                <div className={`${inputCls} flex items-center text-[#64748B] bg-[#FAFBFC]`}>{projectName(projId)}</div>
              </Field>
            ) : (
              <Field label="Project" required>
                <select value={projId} onChange={e => setProjId(e.target.value)} className={inputCls}>
                  <option value="">Select a project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )
          )}

          {/* Assignee type */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setAssigneeType("worker")}
              className={`h-9 rounded-lg border text-[13px] font-semibold transition-colors ${assigneeType === "worker" ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]" : "border-[#E2E8F0] bg-white text-[#64748B] hover:bg-[#F8FAFC]"}`}
            >
              Worker
            </button>
            <button
              type="button"
              onClick={() => setAssigneeType("vendor")}
              className={`h-9 rounded-lg border text-[13px] font-semibold transition-colors ${assigneeType === "vendor" ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]" : "border-[#E2E8F0] bg-white text-[#64748B] hover:bg-[#F8FAFC]"}`}
            >
              Subcontractor
            </button>
          </div>

          {assigneeType === "worker" ? (
            <Field label="Worker" required>
              <select value={workerId} onChange={e => setWorkerId(e.target.value)} className={inputCls}>
                <option value="">Select a worker…</option>
                {sortedWorkers.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.full_name}{w.trade ? ` — ${w.trade}` : ""}{w.active ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <>
              <Field label="Subcontractor" required>
                <input value={subQuery} onChange={e => setSubQuery(e.target.value)} className={`${inputCls} mb-2`} placeholder="Search subcontractors…" />
                <select value={vendorId} onChange={e => setVendorId(e.target.value)} className={inputCls}>
                  <option value="">Select a subcontractor…</option>
                  {subOptions.map(s => <option key={s.id} value={s.id}>{s.company_name}</option>)}
                </select>
              </Field>
              <Field label="Crew size">
                <input value={crewSize} onChange={e => setCrewSize(e.target.value)} type="number" min={1} className={inputCls} placeholder="e.g. 6" />
              </Field>
            </>
          )}

          <Field label="Date" required>
            <input type="date" value={workDate} onChange={e => setWorkDate(e.target.value)} className={inputCls} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start time">
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className={inputCls} />
            </Field>
            <Field label="End time">
              <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className={inputCls} />
            </Field>
          </div>

          <Field label="Status">
            <div className="grid grid-cols-2 gap-2">
              {(["planned", "actual"] as Status[]).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`h-9 rounded-lg border text-[13px] font-semibold capitalize transition-colors ${status === s ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]" : "border-[#E2E8F0] bg-white text-[#64748B] hover:bg-[#F8FAFC]"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Description">
            <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} placeholder="Scope of work that day (optional)" />
          </Field>

          {err && <p className="text-[12px] text-red-600">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[#E2E8F0] sticky bottom-0 bg-white">
          <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
          <button onClick={save} disabled={saving} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add assignment"}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] font-semibold text-[#475569] mb-1">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  )
}
