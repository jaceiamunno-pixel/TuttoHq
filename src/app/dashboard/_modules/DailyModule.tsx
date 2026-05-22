"use client"

import { useState, useEffect, useRef } from "react"
import type { DailyReport, Project, TeamMember } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"

// Daily Reports module — extracted verbatim from dashboard/page.tsx (Step 4 of the split).
// State, handlers, photo sub-system, action bar, content, and both modals are
// unchanged; the load effect keys on globalProjectId (the module mounts only when
// Daily Reports is active, so the activeModule guard is no longer needed).

export default function DailyModule({ globalProjectId, appProjects, teamMembers }: {
  globalProjectId: string
  appProjects: Project[]
  teamMembers: TeamMember[]
}) {
  // Daily reports
  const [dailyReports, setDailyReports]               = useState<DailyReport[]>([])
  const [dailyLoading, setDailyLoading]               = useState(false)
  const [showNewDaily, setShowNewDaily]               = useState(false)
  const [viewDaily, setViewDaily]                     = useState<DailyReport | null>(null)
  const [dailyDate, setDailyDate]                     = useState(() => new Date().toISOString().slice(0, 10))
  const [dailyProjectId, setDailyProjectId]           = useState(globalProjectId)
  const [dailyPreparedBy, setDailyPreparedBy]         = useState("")
  const [dailyWeather, setDailyWeather]               = useState("")
  const [dailyTemp, setDailyTemp]                     = useState("")
  const [dailyManpower, setDailyManpower]             = useState("")
  const [dailyWorkPerformed, setDailyWorkPerformed]   = useState("")
  const [dailyEquipment, setDailyEquipment]           = useState("")
  const [dailyMaterials, setDailyMaterials]           = useState("")
  const [dailyVisitors, setDailyVisitors]             = useState("")
  const [dailyIssues, setDailyIssues]                 = useState("")
  const [dailySafety, setDailySafety]                 = useState("")
  const dailyFileRef  = useRef<HTMLInputElement>(null)
  const [dailySaving, setDailySaving]                 = useState(false)
  const [dailySaveError, setDailySaveError]           = useState("")
  const [dailyEditing, setDailyEditing]               = useState(false)
  const [dailyEditSaving, setDailyEditSaving]         = useState(false)
  const [dailyPhotos, setDailyPhotos]                 = useState<{id: string; url: string; file_name: string}[]>([])
  const [dailyPhotosLoading, setDailyPhotosLoading]   = useState(false)
  const [dailyPhotoUploading, setDailyPhotoUploading] = useState(false)
  const dailyPhotoRef = useRef<HTMLInputElement>(null)
  const [dailyPhotosToAdd, setDailyPhotosToAdd]       = useState<File[]>([])
  const [dailyPhotoUploadError, setDailyPhotoUploadError] = useState("")
  const dailyPhotosToAddRef = useRef<HTMLInputElement>(null)
  const [dailyGeneratingPdf, setDailyGeneratingPdf]   = useState(false)

  function loadDaily(pid = globalProjectId) {
    setDailyLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/daily-reports${qs}`)
      .then(r => r.json())
      .then(d => setDailyReports(d.reports ?? []))
      .catch(() => setDailyReports([]))
      .finally(() => setDailyLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDaily() }, [globalProjectId])

  // Pre-select the current global project whenever the New Daily Report modal opens.
  useEffect(() => { if (showNewDaily) setDailyProjectId(globalProjectId) }, [showNewDaily, globalProjectId])

  useEffect(() => {
    if (viewDaily) { setDailyPhotos([]); loadDailyPhotos(viewDaily.id) }
  }, [viewDaily?.id])

  async function deleteDaily(reportId: string) {
    if (!confirm("Delete this daily report? This cannot be undone.")) return
    await fetch(`/api/daily-reports/${reportId}`, { method: "DELETE" })
    setViewDaily(null)
    loadDaily()
  }

  async function generateDailyPdf(reportId: string) {
    setDailyGeneratingPdf(true)
    try {
      const res = await fetch(`/api/daily-reports/${reportId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadDaily() }
    } finally { setDailyGeneratingPdf(false) }
  }

  async function loadDailyPhotos(id: string) {
    setDailyPhotosLoading(true)
    const res = await fetch(`/api/photos?entity_type=daily_report&entity_id=${id}`)
    if (res.ok) setDailyPhotos(await res.json())
    setDailyPhotosLoading(false)
  }

  async function uploadDailyPhoto(file: File) {
    if (!viewDaily) return
    setDailyPhotoUploading(true)
    const fd = new FormData()
    fd.append("entity_type", "daily_report")
    fd.append("entity_id", viewDaily.id)
    fd.append("file", file)
    const res = await fetch("/api/photos", { method: "POST", body: fd })
    if (res.ok) await loadDailyPhotos(viewDaily.id)
    setDailyPhotoUploading(false)
  }

  async function deleteDailyPhoto(photoId: string) {
    await fetch(`/api/photos?id=${photoId}`, { method: "DELETE" })
    if (viewDaily) await loadDailyPhotos(viewDaily.id)
  }

  async function uploadDailyPhotosAtCreation(reportId: string, files: File[]) {
    const CONCURRENCY = 4
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY)
      const promises = batch.map(file => {
        const fd = new FormData()
        fd.append("entity_type", "daily_report")
        fd.append("entity_id", reportId)
        fd.append("file", file)
        return fetch("/api/photos", { method: "POST", body: fd })
      })
      await Promise.all(promises)
    }
  }

  function openDailyForEdit(r: DailyReport) {
    setViewDaily(r)
    setDailyDate(r.report_date)
    setDailyProjectId(r.project_id ?? "")
    setDailyPreparedBy(r.prepared_by ?? "")
    setDailyWeather(r.weather_conditions ?? "")
    setDailyTemp(r.temperature ?? "")
    setDailyManpower(r.manpower_count != null ? String(r.manpower_count) : "")
    setDailyWorkPerformed(r.work_performed ?? "")
    setDailyEquipment(r.equipment ?? "")
    setDailyMaterials(r.materials_delivered ?? "")
    setDailyVisitors(r.visitors ?? "")
    setDailyIssues(r.issues_delays ?? "")
    setDailySafety(r.safety_notes ?? "")
    setDailyEditing(true)
  }

  async function createDaily(e: React.FormEvent) {
    e.preventDefault()
    setDailySaving(true)
    setDailySaveError("")
    setDailyPhotoUploadError("")
    try {
      const dailyFd = new FormData()
      const dailyFields: Record<string, string> = { report_date: dailyDate, project_id: dailyProjectId, prepared_by: dailyPreparedBy, weather_conditions: dailyWeather, temperature: dailyTemp, manpower_count: dailyManpower, work_performed: dailyWorkPerformed, equipment: dailyEquipment, materials_delivered: dailyMaterials, visitors: dailyVisitors, issues_delays: dailyIssues, safety_notes: dailySafety }
      Object.entries(dailyFields).forEach(([k, v]) => { if (v) dailyFd.append(k, v) })
      if (dailyFileRef.current?.files?.[0]) dailyFd.append("file", dailyFileRef.current.files[0])
      const res = await fetch("/api/daily-reports", { method: "POST", body: dailyFd })
      if (res.ok) {
        const { id: reportId } = await res.json()
        if (dailyPhotosToAdd.length > 0) {
          try {
            await uploadDailyPhotosAtCreation(reportId, dailyPhotosToAdd)
          } catch (photoErr) {
            setDailyPhotoUploadError("Report created, but some photos failed to upload. You can add them manually later.")
          }
        }
        setShowNewDaily(false)
        setDailyDate(new Date().toISOString().slice(0, 10)); setDailyProjectId(""); setDailyPreparedBy(""); setDailyWeather(""); setDailyTemp(""); setDailyManpower(""); setDailyWorkPerformed(""); setDailyEquipment(""); setDailyMaterials(""); setDailyVisitors(""); setDailyIssues(""); setDailySafety("")
        setDailyPhotosToAdd([])
        if (dailyPhotosToAddRef.current) dailyPhotosToAddRef.current.value = ""
        loadDaily()
      } else {
        const data = await res.json().catch(() => ({}))
        setDailySaveError(data.error ?? "Failed to create report. Please try again.")
      }
    } finally { setDailySaving(false) }
  }

  async function saveDaily(e: React.FormEvent) {
    e.preventDefault()
    if (!viewDaily) return
    setDailyEditSaving(true)
    try {
      const res = await fetch(`/api/daily-reports/${viewDaily.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_date: dailyDate, project_id: dailyProjectId || null, prepared_by: dailyPreparedBy || null, weather_conditions: dailyWeather || null, temperature: dailyTemp || null, manpower_count: dailyManpower ? parseInt(dailyManpower) : null, work_performed: dailyWorkPerformed || null, equipment: dailyEquipment || null, materials_delivered: dailyMaterials || null, visitors: dailyVisitors || null, issues_delays: dailyIssues || null, safety_notes: dailySafety || null }),
      })
      if (res.ok) { setViewDaily(null); setDailyEditing(false); loadDaily() }
    } finally { setDailyEditSaving(false) }
  }

  return (
    <>
      {/* Daily reports action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5">
        <p className="text-[13px] font-semibold text-[#0F172A]">Daily Reports <span className="text-[#64748B] font-normal ml-1">({dailyReports.length})</span></p>
        <button onClick={() => { setShowNewDaily(true); setDailyPhotosToAdd([]); setDailyPhotoUploadError(""); if (dailyPhotosToAddRef.current) dailyPhotosToAddRef.current.value = "" }} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5">
          <PlusIcon /> New Report
        </button>
      </div>

      {/* Daily reports */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            dailyLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : dailyReports.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No daily reports yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Log daily site activity, weather, and manpower.</p>
                <button onClick={() => setShowNewDaily(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Report
                </button>
              </div>
            ) : (
              <>
              {/* Desktop table */}
              <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Date</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Work Performed</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Prepared By</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Weather</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Manpower</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyReports.map((r, i) => (
                    <tr key={r.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors cursor-pointer" onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                      <td className="px-4 py-2.5 text-[#64748B] tabular-nums text-[12px]">{dailyReports.length - i}</td>
                      <td className="px-4 py-2.5 text-[#0F172A] font-medium text-[12px] whitespace-nowrap">{fmtDateOnly(r.report_date)}</td>
                      <td className="px-4 py-2.5 max-w-0">
                        <p className="text-[#64748B] text-[12px] truncate">{r.work_performed ?? <span className="text-[#64748B] italic">No description</span>}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{r.prepared_by ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{r.weather_conditions ?? "—"}{r.temperature ? ` · ${r.temperature}` : ""}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px] text-center">{r.manpower_count ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <button onClick={e => { e.stopPropagation(); openDailyForEdit(r) }}
                          className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                          Edit
                        </button>
                        <button onClick={e => { e.stopPropagation(); generateDailyPdf(r.id) }} disabled={dailyGeneratingPdf}
                          className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                        <button onClick={e => { e.stopPropagation(); deleteDaily(r.id) }}
                          className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {dailyReports.map(r => (
                  <div key={r.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm cursor-pointer" onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="text-[13px] font-semibold text-[#0F172A]">{fmtDateOnly(r.report_date)}</p>
                      {r.manpower_count != null && <span className="text-[11px] text-[#64748B]">{r.manpower_count} workers</span>}
                    </div>
                    {r.work_performed && <p className="text-[12px] text-[#64748B] mb-1 line-clamp-2">{r.work_performed}</p>}
                    <div className="flex items-center gap-3 text-[11px] text-[#64748B] mb-2">
                      {r.prepared_by && <span>{r.prepared_by}</span>}
                      {r.weather_conditions && <span>{r.weather_conditions}{r.temperature ? ` · ${r.temperature}` : ""}</span>}
                    </div>
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openDailyForEdit(r)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                      <button onClick={() => generateDailyPdf(r.id)} disabled={dailyGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                      <button onClick={() => deleteDaily(r.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                    </div>
                  </div>
                ))}
              </div>
              </>
            )
          )}
      </div>

      {/* ── New / Edit Daily Report modal ────────────────────────────────── */}
      {(showNewDaily || (viewDaily && dailyEditing)) && (() => {
        const isEdit = !!(viewDaily && dailyEditing)
        const onClose = () => {
          setShowNewDaily(false); setViewDaily(null); setDailyEditing(false);
          setDailyPhotosToAdd([])
          setDailyPhotoUploadError("")
          if (dailyPhotosToAddRef.current) dailyPhotosToAddRef.current.value = ""
        }
        const tareaClass = "w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]"
        return (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
            onClick={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
                <h2 className="text-[15px] font-bold text-[#0F172A]">{isEdit ? "Edit Daily Report" : "New Daily Report"}</h2>
                <button onClick={onClose} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
              </div>
              <form onSubmit={isEdit ? saveDaily : createDaily} className="flex flex-col flex-1 min-h-0">
                <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">

                  {/* Row 1: Date, Project, Prepared By */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="sm:w-36 sm:flex-shrink-0">
                      <label className={labelCls}>Date <span className="text-red-400">*</span></label>
                      <input type="date" required value={dailyDate} onChange={e => setDailyDate(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Project</label>
                      <select value={dailyProjectId} onChange={e => setDailyProjectId(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">None</option>
                        {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Prepared By</label>
                      <select value={dailyPreparedBy} onChange={e => setDailyPreparedBy(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">Select…</option>
                        {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Row 2: Weather, Temp, Manpower */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Weather</label>
                      <select value={dailyWeather} onChange={e => setDailyWeather(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">Select…</option>
                        {["Clear", "Partly Cloudy", "Cloudy", "Rain", "Heavy Rain", "Snow", "Fog", "Wind"].map(w => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                    <div className="sm:w-28 sm:flex-shrink-0">
                      <label className={labelCls}>Temperature</label>
                      <input type="text" value={dailyTemp} onChange={e => setDailyTemp(e.target.value)} placeholder="e.g. 72°F" className={inputCls} />
                    </div>
                    <div className="sm:w-28 sm:flex-shrink-0">
                      <label className={labelCls}>Manpower</label>
                      <input type="number" min={0} value={dailyManpower} onChange={e => setDailyManpower(e.target.value)} placeholder="# workers" className={inputCls} />
                    </div>
                  </div>

                  {/* Work Performed */}
                  <div>
                    <label className={labelCls}>Work Performed</label>
                    <textarea rows={3} value={dailyWorkPerformed} onChange={e => setDailyWorkPerformed(e.target.value)}
                      placeholder="Describe the work completed on site today…" className={tareaClass} />
                  </div>

                  {/* Equipment & Materials side by side */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Equipment on Site</label>
                      <textarea rows={2} value={dailyEquipment} onChange={e => setDailyEquipment(e.target.value)}
                        placeholder="List equipment used…" className={tareaClass} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Materials Delivered</label>
                      <textarea rows={2} value={dailyMaterials} onChange={e => setDailyMaterials(e.target.value)}
                        placeholder="List deliveries received…" className={tareaClass} />
                    </div>
                  </div>

                  {/* Visitors & Issues side by side */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Visitors / Inspections</label>
                      <textarea rows={2} value={dailyVisitors} onChange={e => setDailyVisitors(e.target.value)}
                        placeholder="Inspectors, owner reps, visitors…" className={tareaClass} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Issues / Delays</label>
                      <textarea rows={2} value={dailyIssues} onChange={e => setDailyIssues(e.target.value)}
                        placeholder="Any delays, problems, or concerns…" className={tareaClass} />
                    </div>
                  </div>

                  {/* Safety Notes */}
                  <div>
                    <label className={labelCls}>Safety Notes</label>
                    <textarea rows={2} value={dailySafety} onChange={e => setDailySafety(e.target.value)}
                      placeholder="Safety observations, incidents, toolbox talks…" className={tareaClass} />
                  </div>
                  {!isEdit && (
                    <>
                      <div>
                        <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                        <input ref={dailyFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                      </div>
                      <div className="border-t border-[#E2E8F0] pt-4">
                        <label className={labelCls}>Photo Attachments <span className="text-[#64748B] font-normal">(optional, multiple)</span></label>
                        <div className="flex items-center gap-2 mb-3">
                          <button type="button" onClick={() => dailyPhotosToAddRef.current?.click()}
                            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] bg-[#F4F5F7] hover:bg-white/50 transition-colors font-medium">
                            + Add Photos
                          </button>
                          {dailyPhotosToAdd.length > 0 && (
                            <span className="text-[12px] text-[#64748B]">{dailyPhotosToAdd.length} photo{dailyPhotosToAdd.length !== 1 ? 's' : ''} selected</span>
                          )}
                        </div>
                        <input ref={dailyPhotosToAddRef} type="file" accept="image/*" multiple className="hidden"
                          onChange={e => {
                            const files = Array.from(e.target.files || [])
                            const validFiles = files.filter(f => {
                              const sizeOk = f.size <= 10 * 1024 * 1024
                              if (!sizeOk) setDailyPhotoUploadError(`${f.name} exceeds 10MB limit`)
                              return sizeOk
                            })
                            setDailyPhotosToAdd([...dailyPhotosToAdd, ...validFiles])
                          }} />
                        {dailyPhotosToAdd.length > 0 && (
                          <div className="space-y-2">
                            {dailyPhotosToAdd.map((file, idx) => (
                              <div key={idx} className="flex items-center justify-between p-2 bg-[#F4F5F7] rounded-md border border-[#E2E8F0]">
                                <span className="text-[12px] text-[#0F172A] flex-1 truncate">{file.name} ({(file.size / 1024 / 1024).toFixed(2)}MB)</span>
                                <button type="button" onClick={() => setDailyPhotosToAdd(dailyPhotosToAdd.filter((_, i) => i !== idx))}
                                  className="ml-2 text-[#64748B] hover:text-red-500 text-[14px] font-bold transition-colors">
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {dailyPhotoUploadError && (
                          <p className="text-[12px] text-red-500 mt-2">{dailyPhotoUploadError}</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                  {!isEdit && dailySaveError ? (
                    <p className="text-[12px] text-red-500 flex-1 mr-2">{dailySaveError}</p>
                  ) : <span />}
                  <div className="flex gap-2 flex-shrink-0">
                    <button type="button" onClick={onClose}
                      className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={isEdit ? dailyEditSaving : dailySaving}
                      className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                      {(isEdit ? dailyEditSaving : dailySaving) && <SpinnerIcon className="h-3 w-3" />}
                      {isEdit ? (dailyEditSaving ? "Saving…" : "Save Changes") : (dailySaving ? "Creating…" : "Create Report")}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )
      })()}

      {/* ── View Daily Report modal ───────────────────────────────────────── */}
      {viewDaily && !dailyEditing && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewDaily(null) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[620px] mx-4 sm:mx-0 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <p className="text-[11px] text-[#64748B] uppercase tracking-widest font-bold">Daily Report</p>
                <h2 className="text-[16px] font-bold text-[#0F172A] mt-0.5">{fmtDateOnly(viewDaily.report_date)}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openDailyForEdit(viewDaily)}
                  className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Edit
                </button>
                <button onClick={() => generateDailyPdf(viewDaily.id)} disabled={dailyGeneratingPdf}
                  className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#7B9BB5] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                  {dailyGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" />Generating…</> : "PDF"}
                </button>
                <button onClick={() => deleteDaily(viewDaily.id)}
                  className="h-7 px-3 rounded-md border border-red-900/50 text-[12px] text-red-400 hover:bg-red-900/20 transition-colors">
                  Delete
                </button>
                <button onClick={() => setViewDaily(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              {/* Meta row */}
              <div className="flex flex-wrap gap-4 text-[12px]">
                {viewDaily.prepared_by && <span><span className="text-[#64748B]">Prepared by: </span><span className="text-[#0F172A]">{viewDaily.prepared_by}</span></span>}
                {viewDaily.weather_conditions && <span><span className="text-[#64748B]">Weather: </span><span className="text-[#0F172A]">{viewDaily.weather_conditions}{viewDaily.temperature ? ` · ${viewDaily.temperature}` : ""}</span></span>}
                {viewDaily.manpower_count != null && <span><span className="text-[#64748B]">Manpower: </span><span className="text-[#0F172A]">{viewDaily.manpower_count} workers</span></span>}
              </div>
              {[
                { label: "Work Performed", value: viewDaily.work_performed },
                { label: "Equipment on Site", value: viewDaily.equipment },
                { label: "Materials Delivered", value: viewDaily.materials_delivered },
                { label: "Visitors / Inspections", value: viewDaily.visitors },
                { label: "Issues / Delays", value: viewDaily.issues_delays },
                { label: "Safety Notes", value: viewDaily.safety_notes },
              ].filter(f => f.value).map(f => (
                <div key={f.label} className="rounded-md bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">{f.label}</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{f.value}</p>
                </div>
              ))}
              {viewDaily.file_name && (
                <div className="flex items-center gap-2 text-[12px] text-[#64748B] px-1">
                  <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span>{viewDaily.file_name}</span>
                </div>
              )}

              {/* Photo section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Photos</span>
                  <button type="button" onClick={() => dailyPhotoRef.current?.click()} disabled={dailyPhotoUploading}
                    className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {dailyPhotoUploading ? <><SpinnerIcon className="h-3 w-3" /> Uploading…</> : "+ Add Photo"}
                  </button>
                  <input ref={dailyPhotoRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadDailyPhoto(f); e.target.value = "" }} />
                </div>
                {dailyPhotosLoading ? (
                  <div className="flex justify-center py-3"><SpinnerIcon className="h-4 w-4 text-[#64748B]" /></div>
                ) : dailyPhotos.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {dailyPhotos.map(ph => (
                      <div key={ph.id} className="relative group aspect-square rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F4F5F7]">
                        <img src={ph.url} alt={ph.file_name ?? ""} className="w-full h-full object-cover cursor-pointer"
                          onClick={() => window.open(ph.url, "_blank")} />
                        <button onClick={() => deleteDailyPhoto(ph.id)}
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center shadow">
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-[#64748B] italic">No photos yet — tap "+ Add Photo" to capture or upload</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
