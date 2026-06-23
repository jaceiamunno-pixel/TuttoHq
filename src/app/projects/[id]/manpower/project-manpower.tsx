"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

// ── Per-project Manpower (assignments) — Phase 3 ─────────────────────────────
// A simple, project-scoped crew schedule: this project's manpower_assignments for
// the visible month, grouped by date, with create / edit / soft-delete. All
// reads/writes go through the RLS-scoped /api/manpower-assignments routes; the
// list is read with ?project_id so the company RLS scope + the project filter
// together pin it to this one project. Double-booking a worker is allowed — the
// API returns { conflict: true } and we badge it, never block it. The full
// calendar UI (and the company-wide view) is Phase 4.

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
function timeLabel(a: Assignment): string {
  const s = fmtTime(a.start_time), e = fmtTime(a.end_time)
  if (s && e) return `${s} – ${e}`
  if (s) return `from ${s}`
  if (e) return `until ${e}`
  return "All day"
}

// Best-effort intra-list double-book detection: same worker, same day, time
// blocks overlap (a missing bound spans the whole day). This badges conflicts
// among the assignments currently loaded for THIS project; cross-project
// conflicts are caught authoritatively by the API at write time (see conflictIds).
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

const today = () => new Date()

export default function ProjectManpower({ projectId, projectName }: { projectId: string; projectName: string }) {
  const now = today()
  const [year, setYear] = useState(now.getFullYear())
  const [month0, setMonth0] = useState(now.getMonth())

  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Conflicts flagged by the API at write time (authoritative, cross-project).
  const [conflictIds, setConflictIds] = useState<Set<string>>(new Set())
  // In-session "Recently deleted" buffer (the list-deleted RPC doesn't exist, so
  // this holds rows soft-deleted during this visit and offers Restore; a reload
  // clears it). Mirrors the Workers roster's pattern.
  const [recentlyDeleted, setRecentlyDeleted] = useState<Assignment[]>([])

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Assignment | null>(null)
  const [formDate, setFormDate] = useState<string | null>(null)

  const { from, to } = useMemo(() => monthRange(year, month0), [year, month0])

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    fetch(`/api/manpower-assignments?project_id=${projectId}&from=${from}&to=${to}`)
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
    fetch("/api/workers")
      .then(r => r.json())
      .then(d => setWorkers(d.workers ?? []))
      .catch(() => {})
  }, [])

  const localConflicts = useMemo(() => computeLocalConflicts(assignments), [assignments])
  const isConflicted = (id: string) => conflictIds.has(id) || localConflicts.has(id)

  // Group by date → sorted date sections (assignments already ordered by the API).
  const grouped = useMemo(() => {
    const map = new Map<string, Assignment[]>()
    for (const a of assignments) {
      const arr = map.get(a.work_date) ?? []
      arr.push(a)
      map.set(a.work_date, arr)
    }
    return [...map.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  }, [assignments])

  function prevMonth() {
    if (month0 === 0) { setMonth0(11); setYear(y => y - 1) } else setMonth0(m => m - 1)
  }
  function nextMonth() {
    if (month0 === 11) { setMonth0(0); setYear(y => y + 1) } else setMonth0(m => m + 1)
  }
  function goToday() { const t = today(); setYear(t.getFullYear()); setMonth0(t.getMonth()) }

  function openCreate(date?: string) {
    setEditing(null)
    setFormDate(date ?? ymd(today()))
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
      const next = new Set(prev)
      if (conflict) next.add(saved.id); else next.delete(saved.id)
      return next
    })
    // A saved row may now fall outside the visible month (date changed) — simplest
    // correct refresh is a reload of the current window.
    const inWindow = saved.work_date >= from && saved.work_date <= to
    if (mode === "edit") {
      setAssignments(rows => inWindow ? rows.map(r => (r.id === saved.id ? saved : r)) : rows.filter(r => r.id !== saved.id))
    } else if (inWindow) {
      setAssignments(rows => [...rows, saved])
    }
  }

  async function remove(a: Assignment) {
    if (!confirm(`Remove this ${a.assignee_type === "worker" ? "worker" : "crew"} assignment? It can be restored this session.`)) return
    const res = await fetch(`/api/manpower-assignments/${a.id}`, { method: "DELETE" })
    if (res.ok) {
      setAssignments(rows => rows.filter(r => r.id !== a.id))
      setRecentlyDeleted(rd => [a, ...rd.filter(r => r.id !== a.id)])
    } else {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to remove assignment")
    }
  }

  async function restore(a: Assignment) {
    const res = await fetch(`/api/manpower-assignments/${a.id}/restore`, { method: "POST" })
    if (res.ok) {
      setRecentlyDeleted(rd => rd.filter(r => r.id !== a.id))
      load()
    } else {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to restore assignment")
    }
  }

  const total = assignments.length

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[1000px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
          <div>
            <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Manpower</h1>
            <p className="text-[13px] text-[#64748B] mt-0.5">Crew schedule for {projectName}. Assign workers and subcontractor crews by day.</p>
          </div>
          <button
            onClick={() => openCreate()}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors whitespace-nowrap self-start sm:self-auto"
          >
            Add assignment
          </button>
        </div>

        {/* Month nav */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1.5">
            <button onClick={prevMonth} aria-label="Previous month" className="h-8 w-8 grid place-items-center rounded-md border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC]">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            <span className="text-[14px] font-semibold text-[#0F172A] min-w-[140px] text-center">{MONTHS[month0]} {year}</span>
            <button onClick={nextMonth} aria-label="Next month" className="h-8 w-8 grid place-items-center rounded-md border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F8FAFC]">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
          <button onClick={goToday} className="h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#475569] hover:bg-[#F8FAFC]">Today</button>
        </div>

        {loadError ? (
          <div className="bg-white rounded-xl border border-red-200 px-6 py-8 text-center">
            <p className="text-[13px] text-red-600">{loadError}</p>
            <button onClick={load} className="mt-3 h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Retry</button>
          </div>
        ) : loading ? (
          <p className="text-[13px] text-[#64748B]">Loading…</p>
        ) : total === 0 ? (
          <div className="bg-white rounded-xl border border-[#E2E8F0] px-6 py-12 text-center">
            <p className="text-[14px] font-semibold text-[#0F172A]">No assignments this month</p>
            <p className="text-[13px] text-[#64748B] mt-1 mb-4">Schedule a worker or a subcontractor crew for a day on this project.</p>
            <button onClick={() => openCreate()} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Add assignment</button>
          </div>
        ) : (
          <>
            <p className="text-[12px] text-[#64748B] mb-2">{total} assignment{total === 1 ? "" : "s"} in {MONTHS[month0]}</p>
            <div className="space-y-4">
              {grouped.map(([date, rows]) => (
                <div key={date} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#E2E8F0] bg-[#FAFBFC]">
                    <p className="text-[13px] font-bold text-[#0F172A]">{dateHeader(date)}</p>
                    <button onClick={() => openCreate(date)} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66]">+ Add</button>
                  </div>
                  <ul>
                    {rows.map(a => (
                      <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[#F1F5F9] last:border-0">
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
                            {timeLabel(a)}
                            {a.assignee_type === "vendor" && a.crew_size ? ` · crew of ${a.crew_size}` : ""}
                            {a.description ? ` · ${a.description}` : ""}
                          </p>
                        </div>
                        <div className="flex-shrink-0 whitespace-nowrap">
                          <button onClick={() => openEdit(a)} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] mr-3">Edit</button>
                          <button onClick={() => remove(a)} className="text-[12px] font-semibold text-red-500 hover:text-red-600">Remove</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}

        {recentlyDeleted.length > 0 && (
          <div className="mt-6 bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#FAFBFC]">
              <p className="text-[12px] font-semibold text-[#0F172A]">Recently deleted <span className="font-normal text-[#94A3B8]">(this session)</span></p>
            </div>
            <ul>
              {recentlyDeleted.map(a => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#F1F5F9] last:border-0">
                  <span className="text-[13px] text-[#64748B] truncate">{assigneeLabel(a)} · {dateHeader(a.work_date)}</span>
                  <button onClick={() => restore(a)} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] whitespace-nowrap">Restore</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {formOpen && (
        <AssignmentFormModal
          projectId={projectId}
          workers={workers}
          assignment={editing}
          defaultDate={formDate ?? ymd(today())}
          onClose={() => setFormOpen(false)}
          onSaved={onSaved}
        />
      )}
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

// ── Create / edit modal ──────────────────────────────────────────────────────
const inputCls = "w-full h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"

function AssignmentFormModal({ projectId, workers, assignment, defaultDate, onClose, onSaved }: {
  projectId: string
  workers: Worker[]
  assignment: Assignment | null
  defaultDate: string
  onClose: () => void
  onSaved: (saved: Assignment, conflict: boolean, mode: "add" | "edit") => void
}) {
  const isEdit = !!assignment
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
    const res = isEdit
      ? await fetch(`/api/manpower-assignments/${assignment!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(base) })
      : await fetch(`/api/manpower-assignments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: projectId, ...base }) })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved(d.assignment as Assignment, !!d.conflict, isEdit ? "edit" : "add")
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl border border-[#E2E8F0] shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0] sticky top-0 bg-white">
          <h2 className="text-[15px] font-bold text-[#0F172A]">{isEdit ? "Edit assignment" : "Add assignment"}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
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
