"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ScheduleImportModal from "./schedule-import-modal"
import ScheduleCalendar from "./schedule-calendar"

// ── Per-project Schedule — the Gantt UI (ADR-011 Phase 3, Slice 3) ───────────
// A classic two-panel Gantt over the Slice-2 API. The LEFT panel is a phase-grouped
// task table; the RIGHT panel is the time-scaled bar chart, row-for-row aligned with
// the table. Bars render from the CPM overlay dates the API computes
// (earlyStartDate→earlyFinishDate) — the engine's ASAP schedule — NOT raw stored
// dates; the stored dates show in the table. Critical-path tasks (overlay.isCritical)
// are red; everything else neutral.
//
// CONTRACT — we consume the routes verbatim and never recompute CPM client-side:
//   • GET  /api/schedule-tasks?project_id=…  → { tasks(+overlay), dependencies, cpm }
//   • POST/PATCH/DELETE/restore on /api/schedule-tasks[/id]
//   • POST/DELETE on /api/schedule-dependencies[/id]  (409 on cycle/duplicate)
// Every read/write carries this one project_id; company scope is RLS's job. We never
// send company_id. After any mutation we refetch — the recompute comes back in the
// GET overlay (e.g. dragging a bar PATCHes the stored dates, then the new schedule
// arrives on reload).

// ── Types (mirror the API row + overlay shapes) ──────────────────────────────
type TaskStatus = "not_started" | "in_progress" | "complete"
type DepType = "FS" | "SS" | "FF" | "SF"

interface ScheduleTask {
  id: string
  project_id: string
  name: string
  phase: string | null
  // Nullable since migration 0023 — a 'backlog' task carries no dates. The dated
  // views filter these out (see datedTasks); the type now matches the API row.
  start_date: string | null
  end_date: string | null
  is_milestone: boolean
  duration_days: number
  percent_complete: number
  actual_start_date: string | null
  actual_end_date: string | null
  sort_order: number
  wbs_code: string | null
  status: TaskStatus
  notes: string | null
  created_at: string
  created_by: string | null
  // CPM overlay — present when cpm.ok (assembleSchedule merges it onto each row).
  earlyStart?: number
  earlyFinish?: number
  lateStart?: number
  lateFinish?: number
  totalFloat?: number
  isCritical?: boolean
  earlyStartDate?: string
  earlyFinishDate?: string
  lateStartDate?: string
  lateFinishDate?: string
}

interface ScheduleDependency {
  id: string
  project_id: string
  predecessor_id: string
  successor_id: string
  dep_type: DepType
  lag_days: number
  created_at: string
  created_by: string | null
}

type CpmSummary =
  | { ok: true; criticalTaskIds: string[]; criticalPath: string[]; projectEnd: string; projectDurationDays: number }
  | { ok: false; error: string }

// ── Date helpers — parse ISO yyyy-mm-dd to UTC ms so diffs are DST-safe ───────
const DAY_MS = 86_400_000
const pad = (n: number) => String(n).padStart(2, "0")
function parseISO(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
}
function isoFromMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function addDays(iso: string, n: number): string {
  return isoFromMs(parseISO(iso) + n * DAY_MS)
}
function dayDiff(a: string, b: string): number {
  return Math.round((parseISO(b) - parseISO(a)) / DAY_MS)
}
function firstOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}
function lastOfMonthIso(iso: string): string {
  const [y, m] = iso.slice(0, 10).split("-").map(Number)
  return isoFromMs(Date.UTC(y, m, 0)) // day 0 of next month = last day of this one
}
function localTodayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function fmtShort(iso: string | null): string {
  if (!iso) return "" // tolerate a null/empty date so a stray backlog row can't crash a label
  const [, m, d] = iso.slice(0, 10).split("-").map(Number)
  return `${MON[m - 1]} ${d}`
}
function weekdayUTC(iso: string): number {
  return new Date(parseISO(iso)).getUTCDay() // 0 = Sun … 6 = Sat
}

// ── Layout + visual constants ────────────────────────────────────────────────
const ROW_H = 38 // every row (band header or task) is this tall — keeps panels aligned
const HEADER_H = 52 // two-tier date axis
const BAR_H = 18
const LEFT_W = 440
const EDGE_GRAB = 7 // px hit-zone at a bar's ends for resize vs move
const UNGROUPED = "Ungrouped"

const ZOOM = {
  day: { pxPerDay: 30, label: "Day" },
  week: { pxPerDay: 12, label: "Week" },
  month: { pxPerDay: 4, label: "Month" },
} as const
type Zoom = keyof typeof ZOOM

const C = {
  barTrack: "#AFC4D6",
  barFill: "#5E7E98",
  barBorder: "#7B9BB5",
  critTrack: "#FCA5A5",
  critFill: "#DC2626",
  critBorder: "#DC2626",
  milestone: "#475569",
  critMilestone: "#DC2626",
  edge: "#94A3B8",
  critEdge: "#DC2626",
  dayGrid: "#F1F5F9",
  weekGrid: "#E9EEF3",
  monthGrid: "#D8E0E8",
  weekend: "#FAFBFC",
  today: "#F59E0B",
  bandBg: "#F4F7FA",
}

// ── Row model — the flattened, phase-grouped list both panels render from ─────
type Row =
  | { kind: "band"; key: string; phase: string; count: number }
  | { kind: "task"; key: string; task: ScheduleTask }

// Build phase bands in first-appearance order (tasks already arrive sorted by
// sort_order → start_date → created_at). Null-phase tasks collect into "Ungrouped",
// always rendered last. Returns the flat row list + a task-id → row-index map for
// aligning bars and dependency arrows.
function buildRows(tasks: ScheduleTask[]): { rows: Row[]; indexByTask: Map<string, number> } {
  const order: string[] = []
  const byPhase = new Map<string, ScheduleTask[]>()
  for (const t of tasks) {
    const phase = t.phase?.trim() || UNGROUPED
    if (!byPhase.has(phase)) {
      byPhase.set(phase, [])
      if (phase !== UNGROUPED) order.push(phase)
    }
    byPhase.get(phase)!.push(t)
  }
  if (byPhase.has(UNGROUPED)) order.push(UNGROUPED)

  const rows: Row[] = []
  for (const phase of order) {
    const list = byPhase.get(phase)!
    rows.push({ kind: "band", key: `band:${phase}`, phase, count: list.length })
    for (const task of list) rows.push({ kind: "task", key: task.id, task })
  }
  const indexByTask = new Map<string, number>()
  rows.forEach((r, i) => { if (r.kind === "task") indexByTask.set(r.task.id, i) })
  return { rows, indexByTask }
}

// A bar's calendar geometry. Prefers the computed overlay dates (the engine's
// schedule); falls back to stored dates when the overlay is absent (cpm:{ok:false}).
function barDates(t: ScheduleTask): { start: string; end: string } {
  // Dated rows only ever reach here (datedTasks filters out null-dated backlog),
  // but fall back to "" defensively so a null can never reach parseISO/.slice.
  const start = t.earlyStartDate ?? t.start_date ?? ""
  const end = t.is_milestone ? start : (t.earlyFinishDate ?? t.end_date ?? start)
  return { start, end }
}

export default function ProjectSchedule({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [tasks, setTasks] = useState<ScheduleTask[]>([])
  const [deps, setDeps] = useState<ScheduleDependency[]>([])
  const [cpm, setCpm] = useState<CpmSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [zoom, setZoom] = useState<Zoom>("week")
  const [view, setView] = useState<"gantt" | "calendar">("gantt")
  const [taskForm, setTaskForm] = useState<{ mode: "create" | "edit"; task: ScheduleTask | null } | null>(null)
  const [depOpen, setDepOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    fetch(`/api/schedule-tasks?project_id=${projectId}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to load schedule")
        return r.json()
      })
      .then((d: { tasks: ScheduleTask[]; dependencies: ScheduleDependency[]; cpm: CpmSummary }) => {
        setTasks(d.tasks ?? [])
        setDeps(d.dependencies ?? [])
        setCpm(d.cpm ?? null)
      })
      .catch(e => setLoadError(e.message ?? "Failed to load schedule"))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(load, [load])

  // ── Backlog partition — the prod-down fix ──────────────────────────────────
  // Backlog (status='backlog') rows carry null start/end (migration 0023). The CPM
  // engine already skips them server-side (api.ts → datedRows); the dated Gantt /
  // timeline / calendar must do the same or null date math crashes the page. Filter
  // ONCE here so every timeline consumer (rows, bounds, bars, edges, calendar) sees
  // only dated tasks. Undated tasks are surfaced as a count, never placed on an axis.
  const datedTasks = useMemo(
    () => tasks.filter(
      (t): t is ScheduleTask & { start_date: string; end_date: string } =>
        t.start_date != null && t.end_date != null,
    ),
    [tasks],
  )
  const backlogCount = tasks.length - datedTasks.length

  const tasksById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])
  const { rows, indexByTask } = useMemo(() => buildRows(datedTasks), [datedTasks])
  const criticalSet = useMemo(
    () => new Set(cpm?.ok ? cpm.criticalTaskIds : []),
    [cpm],
  )

  // Date domain — snapped to whole months so the axis tiles cleanly. Drawn from the
  // bar geometry (overlay-or-stored), defaulting to the current month when empty.
  const { domainStart, domainEnd } = useMemo(() => {
    if (datedTasks.length === 0) {
      const t = localTodayIso()
      return { domainStart: firstOfMonthIso(t), domainEnd: lastOfMonthIso(t) }
    }
    let min: string | null = null
    let max: string | null = null
    for (const t of datedTasks) {
      const { start, end } = barDates(t)
      if (min === null || start < min) min = start
      if (max === null || end > max) max = end
    }
    return { domainStart: firstOfMonthIso(min!), domainEnd: lastOfMonthIso(max!) }
  }, [datedTasks])

  const pxPerDay = ZOOM[zoom].pxPerDay
  const totalDays = dayDiff(domainStart, domainEnd) + 1
  const timelineWidth = totalDays * pxPerDay
  const bodyHeight = rows.length * ROW_H

  const xOf = useCallback((iso: string) => dayDiff(domainStart, iso) * pxPerDay, [domainStart, pxPerDay])

  // ── Mutations — all refetch on success; errors surface in a dismissible banner ─
  async function patchTask(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setActionError(null)
    const res = await fetch(`/api/schedule-tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setActionError(d?.error ?? "Failed to update task")
      return false
    }
    load()
    return true
  }

  async function deleteTask(id: string): Promise<boolean> {
    setActionError(null)
    const res = await fetch(`/api/schedule-tasks/${id}`, { method: "DELETE" })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setActionError(d?.error ?? "Failed to delete task")
      return false
    }
    load()
    return true
  }

  async function deleteDep(id: string): Promise<boolean> {
    setActionError(null)
    const res = await fetch(`/api/schedule-dependencies/${id}`, { method: "DELETE" })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setActionError(d?.error ?? "Failed to delete dependency")
      return false
    }
    load()
    return true
  }

  // ── Bar drag (move / resize) — the one careful seam ──────────────────────────
  // We translate pixel movement into a whole-day delta (snap = round(px / pxPerDay))
  // and PATCH the STORED start/end by that delta. The bar is *drawn* at the computed
  // overlay position, but a delta is relative, so shifting stored dates by N days is
  // correct regardless of any overlay/stored offset. On drop we PATCH then refetch —
  // the recomputed schedule comes back in the GET overlay (no client-side CPM).
  const dragRef = useRef<{ taskId: string; mode: "move" | "resize-start" | "resize-end"; startX: number; origStart: string; origEnd: string } | null>(null)
  const [preview, setPreview] = useState<{ taskId: string; mode: "move" | "resize-start" | "resize-end"; deltaDays: number } | null>(null)

  function onBarPointerDown(e: React.PointerEvent, task: ScheduleTask) {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const localX = e.clientX - rect.left
    let mode: "move" | "resize-start" | "resize-end" = "move"
    if (!task.is_milestone) {
      if (localX <= EDGE_GRAB) mode = "resize-start"
      else if (localX >= rect.width - EDGE_GRAB) mode = "resize-end"
    }
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    // Only dated bars are draggable (backlog rows never render here), so the stored
    // dates are non-null at runtime; "" keeps the type honest if one ever slips in.
    dragRef.current = { taskId: task.id, mode, startX: e.clientX, origStart: task.start_date ?? "", origEnd: task.end_date ?? "" }
    setPreview({ taskId: task.id, mode, deltaDays: 0 })
  }
  function onBarPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    const deltaDays = Math.round((e.clientX - d.startX) / pxPerDay)
    setPreview(p => (p && p.deltaDays === deltaDays ? p : { taskId: d.taskId, mode: d.mode, deltaDays }))
  }
  function onBarPointerUp(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setPreview(null)
    const deltaDays = Math.round((e.clientX - d.startX) / pxPerDay)
    if (deltaDays === 0) return
    let newStart = d.origStart
    let newEnd = d.origEnd
    if (d.mode === "move") {
      newStart = addDays(d.origStart, deltaDays)
      newEnd = addDays(d.origEnd, deltaDays)
    } else if (d.mode === "resize-start") {
      newStart = addDays(d.origStart, deltaDays)
      if (parseISO(newStart) > parseISO(d.origEnd)) newStart = d.origEnd
    } else {
      newEnd = addDays(d.origEnd, deltaDays)
      if (parseISO(newEnd) < parseISO(d.origStart)) newEnd = d.origStart
    }
    const patch: Record<string, string> = {}
    if (newStart !== d.origStart) patch.start_date = newStart
    if (newEnd !== d.origEnd) patch.end_date = newEnd
    if (Object.keys(patch).length) patchTask(d.taskId, patch)
  }

  // ── Scroll sync — left table ↔ right timeline (vertical) + header (horizontal) ─
  const leftBodyRef = useRef<HTMLDivElement>(null)
  const rightBodyRef = useRef<HTMLDivElement>(null)
  const rightHeaderRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)
  function onRightScroll() {
    if (syncing.current) return
    syncing.current = true
    const b = rightBodyRef.current
    if (b) {
      if (rightHeaderRef.current) rightHeaderRef.current.scrollLeft = b.scrollLeft
      if (leftBodyRef.current) leftBodyRef.current.scrollTop = b.scrollTop
    }
    syncing.current = false
  }
  function onLeftScroll() {
    if (syncing.current) return
    syncing.current = true
    if (rightBodyRef.current && leftBodyRef.current) rightBodyRef.current.scrollTop = leftBodyRef.current.scrollTop
    syncing.current = false
  }

  // ── Axis ticks + gridlines (memoized off domain + zoom) ──────────────────────
  const axis = useMemo(() => {
    const months: { key: string; label: string; left: number; width: number }[] = []
    let cur = domainStart
    while (cur <= domainEnd) {
      const mEnd = lastOfMonthIso(cur)
      const clampEnd = mEnd > domainEnd ? domainEnd : mEnd
      const [, m] = cur.slice(0, 10).split("-").map(Number)
      const year = cur.slice(0, 4)
      months.push({
        key: cur,
        label: m === 1 ? `${MON[m - 1]} ${year}` : MON[m - 1],
        left: xOf(cur),
        width: (dayDiff(cur, clampEnd) + 1) * pxPerDay,
      })
      cur = addDays(mEnd, 1)
    }

    // Bottom tier + body gridlines depend on zoom.
    const subTicks: { key: string; label: string; left: number; width: number }[] = []
    const gridlines: { key: string; left: number; color: string }[] = []
    const weekendBands: { key: string; left: number; width: number }[] = []

    if (zoom === "day") {
      for (let i = 0; i < totalDays; i++) {
        const iso = addDays(domainStart, i)
        const left = i * pxPerDay
        const dow = weekdayUTC(iso)
        const isMonthStart = iso.endsWith("-01")
        subTicks.push({ key: iso, label: String(Number(iso.slice(8, 10))), left, width: pxPerDay })
        gridlines.push({ key: iso, left, color: isMonthStart ? C.monthGrid : C.dayGrid })
        if (dow === 0 || dow === 6) weekendBands.push({ key: iso, left, width: pxPerDay })
      }
    } else if (zoom === "week") {
      for (let i = 0; i < totalDays; i++) {
        const iso = addDays(domainStart, i)
        if (weekdayUTC(iso) === 0) {
          const left = i * pxPerDay
          subTicks.push({ key: iso, label: fmtShort(iso), left, width: 7 * pxPerDay })
          gridlines.push({ key: iso, left, color: C.weekGrid })
        }
        if (iso.endsWith("-01")) gridlines.push({ key: `m${iso}`, left: i * pxPerDay, color: C.monthGrid })
      }
    } else {
      for (const m of months) gridlines.push({ key: `m${m.key}`, left: m.left, color: C.monthGrid })
    }

    return { months, subTicks, gridlines, weekendBands }
  }, [domainStart, domainEnd, zoom, totalDays, pxPerDay, xOf])

  const todayIso = localTodayIso()
  const todayLeft = todayIso >= domainStart && todayIso <= domainEnd ? xOf(todayIso) : null

  // ── Dependency arrow paths ───────────────────────────────────────────────────
  // Anchor x per edge type; route a simple 3-segment elbow with an auto-orienting
  // arrowhead. Drawn from committed geometry (not the live drag preview). Edges whose
  // endpoints aren't both visible are skipped — the API already filters dangling
  // edges (soft-deleted endpoints), this just guards the render.
  const edges = useMemo(() => {
    const out: { id: string; d: string; critical: boolean }[] = []
    for (const dep of deps) {
      const pi = indexByTask.get(dep.predecessor_id)
      const si = indexByTask.get(dep.successor_id)
      if (pi == null || si == null) continue
      const pt = tasksById.get(dep.predecessor_id)!
      const st = tasksById.get(dep.successor_id)!
      const pg = barDates(pt)
      const sg = barDates(st)
      const pLeft = xOf(pg.start)
      const pRight = pt.is_milestone ? pLeft : xOf(pg.end) + pxPerDay
      const sLeft = xOf(sg.start)
      const sRight = st.is_milestone ? sLeft : xOf(sg.end) + pxPerDay
      const srcX = dep.dep_type === "SS" || dep.dep_type === "SF" ? pLeft : pRight
      const dstX = dep.dep_type === "FF" || dep.dep_type === "SF" ? sRight : sLeft
      const dstDir = dep.dep_type === "FF" || dep.dep_type === "SF" ? -1 : 1
      const sy = pi * ROW_H + ROW_H / 2
      const ty = si * ROW_H + ROW_H / 2
      const ex = srcX + (dep.dep_type === "SS" || dep.dep_type === "SF" ? -1 : 1) * 12
      const tx = dstX - dstDir * 9
      const d = `M ${srcX} ${sy} H ${ex} V ${ty} H ${tx}`
      const critical = criticalSet.has(dep.predecessor_id) && criticalSet.has(dep.successor_id)
      out.push({ id: dep.id, d: `${d}`, critical })
    }
    return out
  }, [deps, indexByTask, tasksById, xOf, pxPerDay, criticalSet])

  const phases = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) if (t.phase?.trim()) set.add(t.phase.trim())
    return Array.from(set).sort()
  }, [tasks])

  const empty = !loading && !loadError && tasks.length === 0

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#F4F5F7]">
      {/* Heading + primary actions */}
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 sm:px-6 pt-6 pb-3">
        <div className="min-w-0">
          <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Schedule</h1>
          <p className="text-[13px] text-[#64748B] mt-0.5">
            {view === "calendar" ? "Month-calendar lookahead" : "Critical-path Gantt"} for {projectName}.
            {cpm?.ok && datedTasks.length > 0 && (
              <> Finish <span className="font-semibold text-[#475569]">{fmtShort(cpm.projectEnd)}</span> · {cpm.projectDurationDays} working day{cpm.projectDurationDays === 1 ? "" : "s"} · {cpm.criticalTaskIds.length} critical</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Gantt ⇄ Calendar view switch — Calendar is a second rendering of the
              SAME loaded tasks (the PM's month-lookahead format). */}
          <div className="flex items-center rounded-md border border-[#E2E8F0] overflow-hidden">
            {(["gantt", "calendar"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`h-9 px-3.5 text-[12px] font-semibold transition-colors ${view === v ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8FAFC]"}`}
              >
                {v === "gantt" ? "Gantt" : "Calendar"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setImportOpen(true)}
            className="h-9 px-3.5 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] whitespace-nowrap"
          >
            Import PDF
          </button>
          <button
            onClick={() => setDepOpen(true)}
            className="h-9 px-3.5 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] whitespace-nowrap"
          >
            Dependencies
          </button>
          <button
            onClick={() => setTaskForm({ mode: "create", task: null })}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors whitespace-nowrap"
          >
            Add task
          </button>
        </div>
      </div>

      {actionError && (
        <div className="mx-4 sm:mx-6 mb-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-[12px] text-red-700">{actionError}</p>
          <button onClick={() => setActionError(null)} className="text-[12px] font-semibold text-red-600 hover:text-red-700">Dismiss</button>
        </div>
      )}
      {cpm && !cpm.ok && !loading && (
        <div className="mx-4 sm:mx-6 mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[12px] text-amber-800">Schedule could not be computed — bars show the stored dates and the critical path is hidden.</p>
        </div>
      )}
      {loadError && (
        <div className="mx-4 sm:mx-6 mb-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-[12px] text-red-700">{loadError}</p>
          <button onClick={load} className="text-[12px] font-semibold text-red-600 hover:text-red-700">Retry</button>
        </div>
      )}
      {/* Imported backlog (undated) tasks have no place on a dated axis yet — surface
          a count so they're visibly accounted for, not silently dropped. The full
          backlog sidebar is a separate, later task. */}
      {backlogCount > 0 && !loading && (
        <div className="mx-4 sm:mx-6 mb-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
          <p className="text-[12px] text-[#64748B]">
            <span className="font-semibold text-[#475569]">{backlogCount}</span> unscheduled task{backlogCount === 1 ? "" : "s"} (no dates) — in the backlog, not shown on the timeline.
          </p>
        </div>
      )}

      {/* ── Calendar view — month-grid rendering of the SAME loaded tasks ──────── */}
      {view === "calendar" && (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-6">
          {loadError ? null : (
            <ScheduleCalendar
              tasks={datedTasks}
              criticalSet={criticalSet}
              projectId={projectId}
              projectName={projectName}
              onEditTask={(t) => setTaskForm({ mode: "edit", task: tasksById.get(t.id) ?? null })}
            />
          )}
        </div>
      )}

      {/* ── Desktop Gantt ─────────────────────────────────────────────────────── */}
      <div className={`${view === "calendar" ? "hidden" : "hidden lg:flex"} flex-1 min-h-0 px-4 sm:px-6 pb-6`}>
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
          {/* Card toolbar: legend + zoom */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#E2E8F0] bg-[#FAFBFC]">
            <div className="flex items-center gap-4 text-[11px] text-[#64748B]">
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 rounded-[2px]" style={{ background: C.barFill }} /> Task</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 rounded-[2px]" style={{ background: C.critFill }} /> Critical</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rotate-45" style={{ background: C.milestone }} /> Milestone</span>
            </div>
            <div className="flex items-center rounded-md border border-[#E2E8F0] overflow-hidden">
              {(Object.keys(ZOOM) as Zoom[]).map(z => (
                <button
                  key={z}
                  onClick={() => setZoom(z)}
                  className={`h-7 px-3 text-[12px] font-semibold transition-colors ${zoom === z ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8FAFC]"}`}
                >
                  {ZOOM[z].label}
                </button>
              ))}
            </div>
          </div>

          {empty ? (
            <EmptyState onAdd={() => setTaskForm({ mode: "create", task: null })} />
          ) : (
            <div className="flex-1 min-h-0 flex">
              {/* LEFT — task table */}
              <div className="flex-shrink-0 flex flex-col border-r border-[#E2E8F0]" style={{ width: LEFT_W }}>
                <div className="flex items-center flex-shrink-0 border-b border-[#E2E8F0] bg-[#FAFBFC] px-3 text-[10px] font-bold uppercase tracking-wide text-[#64748B]" style={{ height: HEADER_H }}>
                  <span className="flex-1 min-w-0">Task</span>
                  <span className="flex-shrink-0 text-right" style={{ width: 52 }}>Dur</span>
                  <span className="flex-shrink-0 text-right" style={{ width: 68 }}>Start</span>
                  <span className="flex-shrink-0 text-right" style={{ width: 68 }}>End</span>
                  <span className="flex-shrink-0 text-right" style={{ width: 44 }}>%</span>
                </div>
                <div ref={leftBodyRef} onScroll={onLeftScroll} className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {loading ? (
                    <SkeletonRows />
                  ) : (
                    rows.map(row =>
                      row.kind === "band" ? (
                        <div key={row.key} className="flex items-center px-3 font-semibold text-[12px] text-[#334155] border-b border-[#E2E8F0]" style={{ height: ROW_H, background: C.bandBg }}>
                          <span className="truncate">{row.phase}</span>
                          <span className="ml-2 text-[11px] font-normal text-[#94A3B8]">{row.count}</span>
                        </div>
                      ) : (
                        <button
                          key={row.key}
                          type="button"
                          onClick={() => setTaskForm({ mode: "edit", task: row.task })}
                          className="w-full flex items-center px-3 text-left border-b border-[#F1F5F9] hover:bg-[#F4F8FB] transition-colors"
                          style={{ height: ROW_H }}
                        >
                          <span className="flex-1 min-w-0 flex items-center gap-1.5 pl-3">
                            {row.task.is_milestone && <span className="inline-block w-2 h-2 rotate-45 flex-shrink-0" style={{ background: criticalSet.has(row.task.id) ? C.critMilestone : C.milestone }} />}
                            {criticalSet.has(row.task.id) && !row.task.is_milestone && <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 bg-red-500" title="Critical path" />}
                            <span className="truncate text-[13px] text-[#0F172A]">{row.task.name}</span>
                          </span>
                          <span className="flex-shrink-0 text-right text-[12px] text-[#64748B] tabular-nums" style={{ width: 52 }}>{row.task.is_milestone ? "—" : row.task.duration_days}</span>
                          <span className="flex-shrink-0 text-right text-[12px] text-[#64748B] tabular-nums" style={{ width: 68 }}>{fmtShort(row.task.start_date)}</span>
                          <span className="flex-shrink-0 text-right text-[12px] text-[#64748B] tabular-nums" style={{ width: 68 }}>{fmtShort(row.task.end_date)}</span>
                          <span className="flex-shrink-0 text-right text-[12px] text-[#64748B] tabular-nums" style={{ width: 44 }}>{row.task.percent_complete}%</span>
                        </button>
                      )
                    )
                  )}
                </div>
              </div>

              {/* RIGHT — timeline */}
              <div className="flex-1 min-w-0 flex flex-col">
                {/* Date axis header (horizontally synced to the body) */}
                <div ref={rightHeaderRef} className="flex-shrink-0 overflow-hidden border-b border-[#E2E8F0] bg-[#FAFBFC]" style={{ height: HEADER_H }}>
                  <div className="relative" style={{ width: timelineWidth, height: HEADER_H }}>
                    {axis.months.map(m => (
                      <div key={m.key} className="absolute top-0 flex items-center px-2 text-[11px] font-semibold text-[#475569] border-l border-[#E2E8F0]" style={{ left: m.left, width: m.width, height: 24 }}>
                        <span className="truncate">{m.label}</span>
                      </div>
                    ))}
                    {axis.subTicks.map(t => (
                      <div key={t.key} className="absolute flex items-center justify-center text-[10px] text-[#94A3B8] border-l border-[#EEF1F4]" style={{ left: t.left, width: t.width, top: 24, height: HEADER_H - 24 }}>
                        <span className="truncate px-0.5">{t.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Scrollable body: gridlines, weekend bands, today line, edges, bars */}
                <div ref={rightBodyRef} onScroll={onRightScroll} className="flex-1 overflow-auto">
                  <div className="relative" style={{ width: timelineWidth, height: Math.max(bodyHeight, 1) }}>
                    {/* Row backgrounds (align with the left table; bands tinted) */}
                    {rows.map((row, i) => (
                      <div
                        key={row.key}
                        className="absolute left-0 border-b"
                        style={{ top: i * ROW_H, height: ROW_H, width: timelineWidth, background: row.kind === "band" ? C.bandBg : "#fff", borderColor: row.kind === "band" ? "#E2E8F0" : "#F1F5F9" }}
                      />
                    ))}
                    {/* Weekend shading (day zoom) */}
                    {axis.weekendBands.map(b => (
                      <div key={`we${b.key}`} className="absolute top-0" style={{ left: b.left, width: b.width, height: bodyHeight, background: C.weekend }} />
                    ))}
                    {/* Vertical gridlines */}
                    {axis.gridlines.map(g => (
                      <div key={g.key} className="absolute top-0" style={{ left: g.left, width: 1, height: bodyHeight, background: g.color }} />
                    ))}
                    {/* Today marker */}
                    {todayLeft !== null && (
                      <div className="absolute top-0" style={{ left: todayLeft, width: 2, height: bodyHeight, background: C.today, opacity: 0.7 }} title={`Today · ${fmtShort(todayIso)}`} />
                    )}

                    {/* Dependency arrows */}
                    {edges.length > 0 && (
                      <svg className="absolute top-0 left-0 pointer-events-none" width={timelineWidth} height={bodyHeight} style={{ overflow: "visible" }}>
                        <defs>
                          <marker id="sched-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                            <path d="M0,0 L6,3 L0,6 z" fill={C.edge} />
                          </marker>
                          <marker id="sched-arrow-crit" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                            <path d="M0,0 L6,3 L0,6 z" fill={C.critEdge} />
                          </marker>
                        </defs>
                        {edges.map(e => (
                          <path key={e.id} d={e.d} fill="none" stroke={e.critical ? C.critEdge : C.edge} strokeWidth={e.critical ? 1.6 : 1.2} markerEnd={`url(#${e.critical ? "sched-arrow-crit" : "sched-arrow"})`} />
                        ))}
                      </svg>
                    )}

                    {/* Bars */}
                    {rows.map((row, i) => {
                      if (row.kind !== "task") return null
                      return (
                        <Bar
                          key={row.key}
                          task={row.task}
                          rowIndex={i}
                          xOf={xOf}
                          pxPerDay={pxPerDay}
                          critical={criticalSet.has(row.task.id)}
                          preview={preview && preview.taskId === row.task.id ? preview : null}
                          onPointerDown={onBarPointerDown}
                          onPointerMove={onBarPointerMove}
                          onPointerUp={onBarPointerUp}
                        />
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Mobile / narrow — read-oriented list (Gantt view only) ────────────── */}
      <div className={`${view === "calendar" ? "hidden" : "lg:hidden"} flex-1 min-h-0 overflow-y-auto px-4 pb-10`}>
        <MobileSchedule
          loading={loading}
          empty={empty}
          rows={rows}
          domainStart={domainStart}
          totalDays={totalDays}
          criticalSet={criticalSet}
          onAdd={() => setTaskForm({ mode: "create", task: null })}
          onEdit={t => setTaskForm({ mode: "edit", task: t })}
        />
      </div>

      {taskForm && (
        <TaskFormModal
          projectId={projectId}
          mode={taskForm.mode}
          task={taskForm.task}
          phases={phases}
          onClose={() => setTaskForm(null)}
          onSaved={() => { setTaskForm(null); load() }}
          onDelete={async id => { if (await deleteTask(id)) setTaskForm(null) }}
        />
      )}

      {depOpen && (
        <DependencyModal
          projectId={projectId}
          tasks={tasks}
          deps={deps}
          onClose={() => setDepOpen(false)}
          onChanged={load}
          onDelete={deleteDep}
        />
      )}

      {importOpen && (
        <ScheduleImportModal
          projectId={projectId}
          onClose={() => setImportOpen(false)}
          onCommitted={() => load()} // refetch so imported tasks appear in the Gantt + calendar
        />
      )}
    </div>
  )
}

// ── One Gantt bar (or milestone diamond) ─────────────────────────────────────
function Bar({ task, rowIndex, xOf, pxPerDay, critical, preview, onPointerDown, onPointerMove, onPointerUp }: {
  task: ScheduleTask
  rowIndex: number
  xOf: (iso: string) => number
  pxPerDay: number
  critical: boolean
  preview: { mode: "move" | "resize-start" | "resize-end"; deltaDays: number } | null
  onPointerDown: (e: React.PointerEvent, t: ScheduleTask) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
}) {
  const { start, end } = barDates(task)
  const top = rowIndex * ROW_H + (ROW_H - BAR_H) / 2
  const deltaPx = preview ? preview.deltaDays * pxPerDay : 0

  if (task.is_milestone) {
    const cx = xOf(start) + deltaPx
    const size = BAR_H - 2
    return (
      <div
        role="button"
        tabIndex={-1}
        title={`${task.name} · milestone ${fmtShort(start)}`}
        onPointerDown={e => onPointerDown(e, task)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="absolute touch-none cursor-grab active:cursor-grabbing"
        style={{ left: cx - size / 2, top: top + (BAR_H - size) / 2, width: size, height: size }}
      >
        <div className="w-full h-full rotate-45 rounded-[2px] border" style={{ background: critical ? C.critMilestone : C.milestone, borderColor: critical ? C.critBorder : "#334155" }} />
      </div>
    )
  }

  let left = xOf(start)
  let width = Math.max(pxPerDay, (dayDiff(start, end) + 1) * pxPerDay)
  if (preview) {
    if (preview.mode === "move") left += deltaPx
    else if (preview.mode === "resize-start") { left += deltaPx; width = Math.max(pxPerDay, width - deltaPx) }
    else width = Math.max(pxPerDay, width + deltaPx)
  }
  const pct = Math.max(0, Math.min(100, task.percent_complete))

  return (
    <div
      title={`${task.name} · ${fmtShort(start)}–${fmtShort(end)} · ${task.duration_days}d · ${pct}%`}
      onPointerDown={e => onPointerDown(e, task)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute touch-none cursor-grab active:cursor-grabbing"
      style={{ left, top, width, height: BAR_H }}
    >
      <div className="relative w-full h-full rounded-[3px] border overflow-hidden pointer-events-none" style={{ background: critical ? C.critTrack : C.barTrack, borderColor: critical ? C.critBorder : C.barBorder }}>
        <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: critical ? C.critFill : C.barFill }} />
      </div>
      {/* Edge affordance hints (visual only; hit-testing is by offset on the wrapper) */}
      <span className="absolute inset-y-0 left-0 w-1.5 pointer-events-none" />
      <span className="absolute inset-y-0 right-0 w-1.5 pointer-events-none" />
      <span className="absolute top-0 h-full flex items-center pointer-events-none text-[11px] text-[#475569] whitespace-nowrap" style={{ left: width + 6 }}>
        {task.name}
      </span>
    </div>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center px-3 border-b border-[#F1F5F9]" style={{ height: ROW_H }}>
          <span className="h-3.5 rounded bg-[#EEF1F4] animate-pulse" style={{ width: `${50 + ((i * 13) % 40)}%` }} />
        </div>
      ))}
    </>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="w-12 h-12 rounded-full bg-[#EEF2F6] grid place-items-center mb-3">
        <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V9m4 8v-5m4 5v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
      </div>
      <p className="text-[14px] font-semibold text-[#0F172A]">No tasks yet</p>
      <p className="text-[13px] text-[#64748B] mt-1 max-w-xs">Add the first task to start the schedule. Chain tasks with dependencies to compute the critical path.</p>
      <button onClick={onAdd} className="mt-4 h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Add task</button>
    </div>
  )
}

// ── Mobile read view — phase-grouped list with compact, domain-relative bars ──
function MobileSchedule({ loading, empty, rows, domainStart, totalDays, criticalSet, onAdd, onEdit }: {
  loading: boolean
  empty: boolean
  rows: Row[]
  domainStart: string
  totalDays: number
  criticalSet: Set<string>
  onAdd: () => void
  onEdit: (t: ScheduleTask) => void
}) {
  if (loading) {
    return (
      <div className="pt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 rounded-lg bg-white border border-[#E2E8F0] animate-pulse" />)}
      </div>
    )
  }
  if (empty) {
    return (
      <div className="pt-10">
        <div className="rounded-xl border border-[#E2E8F0] bg-white">
          <EmptyState onAdd={onAdd} />
        </div>
      </div>
    )
  }
  return (
    <div className="pt-4 space-y-4">
      {rows.map(row => {
        if (row.kind === "band") {
          return (
            <div key={row.key} className="flex items-center gap-2 pt-2">
              <h3 className="text-[12px] font-bold uppercase tracking-wide text-[#475569]">{row.phase}</h3>
              <span className="text-[11px] text-[#94A3B8]">{row.count}</span>
            </div>
          )
        }
        const t = row.task
        const { start, end } = barDates(t)
        const crit = criticalSet.has(t.id)
        const leftPct = totalDays > 0 ? (dayDiff(domainStart, start) / totalDays) * 100 : 0
        const widthPct = totalDays > 0 ? ((dayDiff(start, end) + 1) / totalDays) * 100 : 100
        return (
          <button
            key={row.key}
            type="button"
            onClick={() => onEdit(t)}
            className="w-full text-left rounded-lg border border-[#E2E8F0] bg-white px-3.5 py-3 hover:bg-[#F8FAFC] transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex items-center gap-1.5">
                {t.is_milestone && <span className="inline-block w-2 h-2 rotate-45 flex-shrink-0" style={{ background: crit ? C.critMilestone : C.milestone }} />}
                <span className="truncate text-[13px] font-semibold text-[#0F172A]">{t.name}</span>
              </div>
              {crit && <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide text-red-700 bg-red-100 border border-red-200 rounded px-1.5 py-0.5">Critical</span>}
            </div>
            <div className="mt-2 relative h-2 rounded-full bg-[#EEF1F4] overflow-hidden">
              <div className="absolute inset-y-0 rounded-full" style={{ left: `${leftPct}%`, width: `${Math.max(2, widthPct)}%`, background: crit ? C.critTrack : C.barTrack }}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(0, Math.min(100, t.percent_complete))}%`, background: crit ? C.critFill : C.barFill }} />
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-[#64748B] tabular-nums">
              {fmtShort(t.start_date)} – {fmtShort(t.end_date)}{t.is_milestone ? " · milestone" : ` · ${t.duration_days}d`} · {t.percent_complete}%
            </p>
          </button>
        )
      })}
    </div>
  )
}

// ── Shared form primitives (match the manpower modal) ─────────────────────────
const inputCls = "w-full h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] font-semibold text-[#475569] mb-1">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  )
}

// ── Create / edit task modal ──────────────────────────────────────────────────
function TaskFormModal({ projectId, mode, task, phases, onClose, onSaved, onDelete }: {
  projectId: string
  mode: "create" | "edit"
  task: ScheduleTask | null
  phases: string[]
  onClose: () => void
  onSaved: () => void
  onDelete: (id: string) => void
}) {
  const isEdit = mode === "edit" && !!task
  const [name, setName] = useState(task?.name ?? "")
  const [phase, setPhase] = useState(task?.phase ?? "")
  const [startDate, setStartDate] = useState(task?.start_date ?? localTodayIso())
  const [endDate, setEndDate] = useState(task?.end_date ?? localTodayIso())
  const [isMilestone, setIsMilestone] = useState(task?.is_milestone ?? false)
  const [pct, setPct] = useState(task ? String(task.percent_complete) : "0")
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "not_started")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // A milestone is a single instant — keep end pinned to start.
  useEffect(() => { if (isMilestone) setEndDate(startDate) }, [isMilestone, startDate])

  async function save() {
    setErr(null)
    if (!name.trim()) { setErr("Name is required."); return }
    if (!startDate) { setErr("Pick a start date."); return }
    const effectiveEnd = isMilestone ? startDate : endDate
    if (!effectiveEnd) { setErr("Pick an end date."); return }
    if (parseISO(effectiveEnd) < parseISO(startDate)) { setErr("End date must be on or after the start date."); return }
    const nPct = Number(pct)
    if (!Number.isInteger(nPct) || nPct < 0 || nPct > 100) { setErr("Percent complete must be 0–100."); return }

    setSaving(true)
    const payload = {
      name: name.trim(),
      phase: phase.trim() || null,
      start_date: startDate,
      end_date: effectiveEnd,
      is_milestone: isMilestone,
      percent_complete: nPct,
      status,
    }
    const res = isEdit
      ? await fetch(`/api/schedule-tasks/${task!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await fetch(`/api/schedule-tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: projectId, ...payload }) })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl border border-[#E2E8F0] shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0] sticky top-0 bg-white">
          <h2 className="text-[15px] font-bold text-[#0F172A]">{isEdit ? "Edit task" : "Add task"}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <Field label="Name" required>
            <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. Pour foundations" autoFocus />
          </Field>

          <Field label="Phase">
            <input value={phase} onChange={e => setPhase(e.target.value)} className={inputCls} placeholder="e.g. Structure (optional)" list="schedule-phases" />
            <datalist id="schedule-phases">
              {phases.map(p => <option key={p} value={p} />)}
            </datalist>
          </Field>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={isMilestone} onChange={e => setIsMilestone(e.target.checked)} className="w-4 h-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]/40" />
            <span className="text-[13px] text-[#0F172A]">Milestone (a single dated point, zero duration)</span>
          </label>

          <div className={`grid gap-3 ${isMilestone ? "grid-cols-1" : "grid-cols-2"}`}>
            <Field label={isMilestone ? "Date" : "Start"} required>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} />
            </Field>
            {!isMilestone && (
              <Field label="End" required>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={inputCls} />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="% complete">
              <input type="number" min={0} max={100} value={pct} onChange={e => setPct(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Status">
              <select value={status} onChange={e => setStatus(e.target.value as TaskStatus)} className={inputCls}>
                <option value="not_started">Not started</option>
                <option value="in_progress">In progress</option>
                <option value="complete">Complete</option>
              </select>
            </Field>
          </div>

          {err && <p className="text-[12px] text-red-600">{err}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-[#E2E8F0] sticky bottom-0 bg-white">
          {isEdit ? (
            <button
              onClick={() => { if (confirm("Delete this task? It can be restored from the database.")) onDelete(task!.id) }}
              className="h-9 px-3 rounded-md text-[13px] font-semibold text-red-500 hover:text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
            <button onClick={save} disabled={saving} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Dependencies modal — list existing edges + add a new one ──────────────────
const DEP_LABEL: Record<DepType, string> = {
  FS: "Finish → Start",
  SS: "Start → Start",
  FF: "Finish → Finish",
  SF: "Start → Finish",
}

function DependencyModal({ projectId, tasks, deps, onClose, onChanged, onDelete }: {
  projectId: string
  tasks: ScheduleTask[]
  deps: ScheduleDependency[]
  onClose: () => void
  onChanged: () => void
  onDelete: (id: string) => Promise<boolean>
}) {
  const [pred, setPred] = useState("")
  const [succ, setSucc] = useState("")
  const [type, setType] = useState<DepType>("FS")
  const [lag, setLag] = useState("0")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const nameOf = useCallback((id: string) => tasks.find(t => t.id === id)?.name ?? "Task", [tasks])
  const sorted = useMemo(() => [...tasks].sort((a, b) => a.name.localeCompare(b.name)), [tasks])

  // The GET returns every project edge — including "dangling" ones whose endpoint
  // was soft-deleted (kept in the DB so a restore is lossless). Show only edges
  // between live tasks, matching what the chart draws; dangling edges reappear here
  // if their task is restored.
  const liveIds = useMemo(() => new Set(tasks.map(t => t.id)), [tasks])
  const visibleDeps = useMemo(
    () => deps.filter(d => liveIds.has(d.predecessor_id) && liveIds.has(d.successor_id)),
    [deps, liveIds],
  )

  async function add() {
    setErr(null)
    if (!pred || !succ) { setErr("Pick both a predecessor and a successor."); return }
    if (pred === succ) { setErr("A task cannot depend on itself."); return }
    const nLag = Number(lag || "0")
    if (!Number.isInteger(nLag)) { setErr("Lag must be a whole number of working days (negative = lead)."); return }

    setSaving(true)
    const res = await fetch(`/api/schedule-dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The live route reads snake_case dep_type / lag_days (the camelCase names in
      // the slice brief never reached the merged code) — send what it actually parses.
      body: JSON.stringify({ project_id: projectId, predecessor_id: pred, successor_id: succ, dep_type: type, lag_days: nLag }),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) {
      // The cycle gate already prevented the write — surface a clean message, don't crash.
      if (res.status === 409 && d?.cycleNodeIds !== undefined) setErr("This would create a circular dependency — nothing was added.")
      else if (res.status === 409) setErr("That dependency already exists.")
      else setErr(d?.error ?? "Failed to add dependency.")
      return
    }
    setErr(null)
    setPred("")
    setSucc("")
    setType("FS")
    setLag("0")
    onChanged()
  }

  async function remove(id: string) {
    await onDelete(id)
    // onDelete already refetches at the parent; deps prop updates on re-render.
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-xl border border-[#E2E8F0] shadow-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0]">
          <h2 className="text-[15px] font-bold text-[#0F172A]">Dependencies</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Add form */}
        <div className="px-5 py-4 border-b border-[#E2E8F0] space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Predecessor" required>
              <select value={pred} onChange={e => setPred(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {sorted.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Successor" required>
              <select value={succ} onChange={e => setSucc(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {sorted.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select value={type} onChange={e => setType(e.target.value as DepType)} className={inputCls}>
                {(Object.keys(DEP_LABEL) as DepType[]).map(t => <option key={t} value={t}>{t} · {DEP_LABEL[t]}</option>)}
              </select>
            </Field>
            <Field label="Lag (working days)">
              <input type="number" value={lag} onChange={e => setLag(e.target.value)} className={inputCls} placeholder="0 (− = lead)" />
            </Field>
          </div>
          {err && <p className="text-[12px] text-red-600">{err}</p>}
          <div className="flex justify-end">
            <button onClick={add} disabled={saving} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
              {saving ? "Adding…" : "Add dependency"}
            </button>
          </div>
        </div>

        {/* Existing edges */}
        <div className="flex-1 overflow-y-auto">
          {visibleDeps.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-[#64748B]">No dependencies yet. Chain tasks above to drive the critical path.</p>
          ) : (
            <ul>
              {visibleDeps.map(dep => (
                <li key={dep.id} className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[#F1F5F9] last:border-0">
                  <div className="min-w-0">
                    <p className="text-[13px] text-[#0F172A] truncate">
                      <span className="font-semibold">{nameOf(dep.predecessor_id)}</span>
                      <span className="text-[#94A3B8]"> → </span>
                      <span className="font-semibold">{nameOf(dep.successor_id)}</span>
                    </p>
                    <p className="text-[11px] text-[#64748B] mt-0.5">
                      {dep.dep_type} · {DEP_LABEL[dep.dep_type]}{dep.lag_days ? ` · ${dep.lag_days > 0 ? "+" : ""}${dep.lag_days}d lag` : ""}
                    </p>
                  </div>
                  <button onClick={() => remove(dep.id)} className="flex-shrink-0 text-[12px] font-semibold text-red-500 hover:text-red-600">Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end px-5 py-3.5 border-t border-[#E2E8F0]">
          <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Done</button>
        </div>
      </div>
    </div>
  )
}
