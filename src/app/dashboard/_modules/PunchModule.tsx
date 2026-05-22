"use client"

import { useState, useEffect, useRef } from "react"
import type { PunchItem, Project } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { PunchStatusBadge, PunchPriorityBadge } from "../_shared/badges"
import { inputCls, labelCls } from "../_shared/ui"

// Punch List module — extracted verbatim from dashboard/page.tsx (Step 3 of the split).
// State, handlers, photo sub-system, action bar, content, and both modals are
// unchanged; the load effect keys on globalProjectId (the module mounts only when
// Punch is active, so the activeModule guard is no longer needed).

export default function PunchModule({ globalProjectId, appProjects }: {
  globalProjectId: string
  appProjects: Project[]
}) {
  // Punch list
  const [punchItems, setPunchItems]               = useState<PunchItem[]>([])
  const [punchLoading, setPunchLoading]           = useState(false)
  const [showNewPunch, setShowNewPunch]           = useState(false)
  const [viewPunch, setViewPunch]                 = useState<PunchItem | null>(null)
  const [punchDesc, setPunchDesc]                 = useState("")
  const [punchLocation, setPunchLocation]         = useState("")
  const [punchAssignedTo, setPunchAssignedTo]     = useState("")
  const [punchDueDate, setPunchDueDate]           = useState("")
  const [punchPriority, setPunchPriority]         = useState("Medium")
  const [punchProjectId, setPunchProjectId]       = useState(globalProjectId)
  const [punchNotes, setPunchNotes]               = useState("")
  const punchFileRef  = useRef<HTMLInputElement>(null)
  const [punchSaving, setPunchSaving]             = useState(false)
  const [punchEditStatus, setPunchEditStatus]     = useState("")
  const [punchEditNotes, setPunchEditNotes]       = useState("")
  const [punchEditSaving, setPunchEditSaving]     = useState(false)
  const [punchPhotos, setPunchPhotos]             = useState<{id: string; url: string; file_name: string}[]>([])
  const [punchPhotosLoading, setPunchPhotosLoading] = useState(false)
  const [punchPhotoUploading, setPunchPhotoUploading] = useState(false)
  const punchPhotoRef = useRef<HTMLInputElement>(null)
  const [punchGeneratingPdf, setPunchGeneratingPdf]   = useState(false)

  function loadPunch(pid = globalProjectId) {
    setPunchLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/punch${qs}`)
      .then(r => r.json())
      .then(d => setPunchItems(d.items ?? []))
      .catch(() => setPunchItems([]))
      .finally(() => setPunchLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadPunch() }, [globalProjectId])

  // Pre-select the current global project whenever the New Punch modal opens.
  useEffect(() => { if (showNewPunch) setPunchProjectId(globalProjectId) }, [showNewPunch, globalProjectId])

  useEffect(() => {
    if (viewPunch) { setPunchPhotos([]); loadPunchPhotos(viewPunch.id) }
  }, [viewPunch?.id])

  async function createPunch(e: React.FormEvent) {
    e.preventDefault()
    setPunchSaving(true)
    try {
      const punchFd = new FormData()
      const punchFields: Record<string, string> = { description: punchDesc, location: punchLocation, assigned_to: punchAssignedTo, due_date: punchDueDate, priority: punchPriority, project_id: punchProjectId, notes: punchNotes }
      Object.entries(punchFields).forEach(([k, v]) => { if (v) punchFd.append(k, v) })
      if (punchFileRef.current?.files?.[0]) punchFd.append("file", punchFileRef.current.files[0])
      const res = await fetch("/api/punch", { method: "POST", body: punchFd })
      if (res.ok) {
        setShowNewPunch(false)
        setPunchDesc(""); setPunchLocation(""); setPunchAssignedTo(""); setPunchDueDate(""); setPunchPriority("Medium"); setPunchProjectId(""); setPunchNotes("")
        loadPunch()
      }
    } finally { setPunchSaving(false) }
  }

  async function updatePunch() {
    if (!viewPunch) return
    setPunchEditSaving(true)
    try {
      const res = await fetch(`/api/punch/${viewPunch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: punchEditStatus, notes: punchEditNotes }),
      })
      if (res.ok) { setViewPunch(null); loadPunch() }
    } finally { setPunchEditSaving(false) }
  }

  async function deletePunchItem(itemId: string) {
    if (!confirm("Delete this punch item? This cannot be undone.")) return
    await fetch(`/api/punch/${itemId}`, { method: "DELETE" })
    setViewPunch(null)
    loadPunch()
  }

  async function generatePunchPdf(itemId: string) {
    setPunchGeneratingPdf(true)
    try {
      const res = await fetch(`/api/punch/${itemId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadPunch() }
    } finally { setPunchGeneratingPdf(false) }
  }

  async function loadPunchPhotos(id: string) {
    setPunchPhotosLoading(true)
    const res = await fetch(`/api/photos?entity_type=punch_item&entity_id=${id}`)
    if (res.ok) setPunchPhotos(await res.json())
    setPunchPhotosLoading(false)
  }

  async function uploadPunchPhoto(file: File) {
    if (!viewPunch) return
    setPunchPhotoUploading(true)
    const fd = new FormData()
    fd.append("entity_type", "punch_item")
    fd.append("entity_id", viewPunch.id)
    fd.append("file", file)
    const res = await fetch("/api/photos", { method: "POST", body: fd })
    if (res.ok) await loadPunchPhotos(viewPunch.id)
    setPunchPhotoUploading(false)
  }

  async function deletePunchPhoto(photoId: string) {
    await fetch(`/api/photos?id=${photoId}`, { method: "DELETE" })
    if (viewPunch) await loadPunchPhotos(viewPunch.id)
  }

  return (
    <>
      {/* Punch list action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 truncate">
          <p className="text-[13px] font-semibold text-[#0F172A] truncate">Punch List <span className="text-[#64748B] font-normal ml-1">({punchItems.filter(p => p.status !== "Void").length})</span></p>
        </div>
        <button onClick={() => setShowNewPunch(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
          <PlusIcon /> New Item
        </button>
      </div>

      {/* Punch list */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            punchLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : punchItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No punch items yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Add items to track deficiencies and corrections.</p>
                <button onClick={() => setShowNewPunch(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Item
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
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Item</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Description</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Location</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Assigned To</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Due</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Priority</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {punchItems.map((p, i) => {
                    const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== "Completed" && p.status !== "Void"
                    const isStruck  = p.status === "Completed" || p.status === "Void"
                    return (
                      <tr key={p.id} className={`border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors ${isStruck ? "opacity-50" : ""}`}>
                        <td className="px-4 py-2.5 text-[#64748B] tabular-nums text-[12px]">{punchItems.length - i}</td>
                        <td className="px-4 py-2.5 text-[12px] font-mono text-[#7B9BB5]">{p.item_number}</td>
                        <td className="px-4 py-2.5 max-w-0">
                          <p className={`font-medium truncate ${isStruck ? "line-through text-[#64748B]" : "text-[#0F172A]"}`} title={p.description}>{p.description}</p>
                        </td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{p.location ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{p.assigned_to ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                          {p.due_date
                            ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>{fmtDateOnly(p.due_date)}{isOverdue ? " ⚠" : ""}</span>
                            : <span className="text-[#64748B]">—</span>}
                        </td>
                        <td className="px-4 py-2.5"><PunchPriorityBadge priority={p.priority} /></td>
                        <td className="px-4 py-2.5"><PunchStatusBadge status={p.status} /></td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => { setViewPunch(p); setPunchEditStatus(p.status); setPunchEditNotes(p.notes ?? "") }}
                            className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                            Edit
                          </button>
                          <button onClick={() => generatePunchPdf(p.id)} disabled={punchGeneratingPdf}
                            className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                          <button onClick={e => { e.stopPropagation(); deletePunchItem(p.id) }}
                            className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {punchItems.map(p => {
                  const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== "Completed" && p.status !== "Void"
                  const isStruck = p.status === "Completed" || p.status === "Void"
                  return (
                    <div key={p.id} className={`bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm ${isStruck ? "opacity-50" : ""}`}>
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <span className="text-[11px] font-mono text-[#7B9BB5]">{p.item_number}</span>
                        <div className="flex items-center gap-1">
                          <PunchPriorityBadge priority={p.priority} />
                          <PunchStatusBadge status={p.status} />
                        </div>
                      </div>
                      <p className={`text-[13px] font-medium mb-1 ${isStruck ? "line-through text-[#64748B]" : "text-[#0F172A]"}`}>{p.description}</p>
                      {p.location && <p className="text-[11px] text-[#64748B] mb-0.5">Location: {p.location}</p>}
                      {p.assigned_to && <p className="text-[11px] text-[#64748B] mb-1">Assigned: {p.assigned_to}</p>}
                      {p.due_date && <p className="text-[11px] mb-2"><span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>Due: {fmtDateOnly(p.due_date)}{isOverdue ? " ⚠" : ""}</span></p>}
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setViewPunch(p); setPunchEditStatus(p.status); setPunchEditNotes(p.notes ?? "") }} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                        <button onClick={() => generatePunchPdf(p.id)} disabled={punchGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                        <button onClick={e => { e.stopPropagation(); deletePunchItem(p.id) }} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              </>
            )
          )}
      </div>

      {/* ── New Punch Item modal ─────────────────────────────────────────── */}
      {showNewPunch && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setShowNewPunch(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[520px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
            <div className="flex-shrink-0 flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <h2 className="text-[15px] font-bold text-[#0F172A]">New Punch Item</h2>
              <button onClick={() => setShowNewPunch(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createPunch} className="flex flex-col flex-1 min-h-0">
              <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
                <div>
                  <label className={labelCls}>Description <span className="text-red-400">*</span></label>
                  <textarea required rows={2} value={punchDesc} onChange={e => setPunchDesc(e.target.value)} autoFocus
                    placeholder="Describe the deficiency, item to correct, or work to complete"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Location / Room</label>
                    <input type="text" value={punchLocation} onChange={e => setPunchLocation(e.target.value)}
                      placeholder="e.g. Room 201, Lobby, Roof" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Assigned To</label>
                    <input type="text" value={punchAssignedTo} onChange={e => setPunchAssignedTo(e.target.value)}
                      placeholder="Trade or subcontractor" className={inputCls} />
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Priority</label>
                    <select value={punchPriority} onChange={e => setPunchPriority(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      {["Low", "Medium", "High", "Critical"].map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Due Date</label>
                    <input type="date" value={punchDueDate} onChange={e => setPunchDueDate(e.target.value)} className={inputCls} />
                  </div>
                </div>
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={punchProjectId} onChange={e => setPunchProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea rows={2} value={punchNotes} onChange={e => setPunchNotes(e.target.value)}
                    placeholder="Additional context, spec references, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                  <input ref={punchFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button type="button" onClick={() => setShowNewPunch(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={punchSaving || !punchDesc.trim()}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {punchSaving && <SpinnerIcon className="h-3 w-3" />}
                  {punchSaving ? "Adding…" : "Add Item"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── View/Edit Punch Item modal ────────────────────────────────────── */}
      {viewPunch && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewPunch(null) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[500px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
            <div className="flex-shrink-0 flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <div>
                <span className="text-[11px] font-mono text-[#7B9BB5]">{viewPunch.item_number}</span>
                <h2 className="text-[15px] font-bold text-[#0F172A] mt-0.5">{viewPunch.description}</h2>
              </div>
              <button onClick={() => setViewPunch(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors ml-4 flex-shrink-0">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                {viewPunch.location && <div><span className="text-[#64748B]">Location: </span><span className="text-[#0F172A]">{viewPunch.location}</span></div>}
                {viewPunch.assigned_to && <div><span className="text-[#64748B]">Assigned to: </span><span className="text-[#0F172A]">{viewPunch.assigned_to}</span></div>}
                {viewPunch.due_date && <div><span className="text-[#64748B]">Due: </span><span className={new Date(viewPunch.due_date) < new Date() && viewPunch.status !== "Completed" ? "text-red-400 font-medium" : "text-[#0F172A]"}>{fmtDateOnly(viewPunch.due_date)}</span></div>}
                <div className="flex items-center gap-1.5"><span className="text-[#64748B]">Priority: </span><PunchPriorityBadge priority={viewPunch.priority} /></div>
              </div>
              {viewPunch.notes && (
                <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Notes</p>
                  <p className="text-[13px] text-[#0F172A]">{viewPunch.notes}</p>
                </div>
              )}
              {viewPunch.file_name && (
                <div className="flex items-center gap-2 text-[12px] text-[#64748B]">
                  <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span>{viewPunch.file_name}</span>
                </div>
              )}

              {/* Photo section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className={labelCls}>Photos</span>
                  <button type="button" onClick={() => punchPhotoRef.current?.click()} disabled={punchPhotoUploading}
                    className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {punchPhotoUploading ? <><SpinnerIcon className="h-3 w-3" /> Uploading…</> : "+ Add Photo"}
                  </button>
                  <input ref={punchPhotoRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadPunchPhoto(f); e.target.value = "" }} />
                </div>
                {punchPhotosLoading ? (
                  <div className="flex justify-center py-3"><SpinnerIcon className="h-4 w-4 text-[#64748B]" /></div>
                ) : punchPhotos.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {punchPhotos.map(ph => (
                      <div key={ph.id} className="relative group aspect-square rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F4F5F7]">
                        <img src={ph.url} alt={ph.file_name ?? ""} className="w-full h-full object-cover cursor-pointer"
                          onClick={() => window.open(ph.url, "_blank")} />
                        <button onClick={() => deletePunchPhoto(ph.id)}
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

              <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
                <div>
                  <label className={labelCls}>Update Notes</label>
                  <textarea value={punchEditNotes} onChange={e => setPunchEditNotes(e.target.value)} rows={3}
                    placeholder="Add resolution notes, corrective action taken, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={punchEditStatus} onChange={e => setPunchEditStatus(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    {["Open", "In Progress", "Completed", "Void"].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-between px-6 py-4 border-t border-[#E2E8F0]">
              <div className="flex gap-2">
                <button onClick={() => generatePunchPdf(viewPunch.id)} disabled={punchGeneratingPdf}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {punchGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" /> Generating…</> : "Generate PDF"}
                </button>
                <button onClick={() => deletePunchItem(viewPunch.id)}
                  className="h-8 px-4 rounded-md border border-red-900/50 text-[13px] text-red-400 hover:bg-red-900/20 transition-colors">
                  Delete
                </button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setViewPunch(null)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Close
                </button>
                <button onClick={updatePunch} disabled={punchEditSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {punchEditSaving && <SpinnerIcon className="h-3 w-3" />}
                  {punchEditSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
