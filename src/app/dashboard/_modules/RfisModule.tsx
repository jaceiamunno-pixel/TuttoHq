"use client"

import { useState, useEffect, useRef } from "react"
import type { RFI, Project, TeamMember } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { RfiStatusBadge } from "../_shared/badges"
import { inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"
import { useNavRegion, useFocusTrap } from "@/components/keyboard-nav"
import { SkeletonTable } from "@/components/skeleton"

// RFI Log module — extracted verbatim from dashboard/page.tsx (Step 5 of the split).
// State, handlers, action bar, content, and both modals are unchanged; the load
// effect keys on globalProjectId (the module mounts only when RFIs is active,
// so the activeModule guard is no longer needed).

export default function RfisModule({ globalProjectId, appProjects, teamMembers }: {
  globalProjectId: string
  appProjects: Project[]
  teamMembers: TeamMember[]
}) {
  // RFI log
  const [rfis, setRfis]                               = useState<RFI[]>([])
  const [rfisLoading, setRfisLoading]                 = useState(false)
  const [showNewRfi, setShowNewRfi]                   = useState(false)
  const [viewRfi, setViewRfi]                         = useState<RFI | null>(null)
  // Keyboard-nav: the RFI log is a region (order 20); the view/respond modal
  // traps focus while open and restores it to the row on Escape.
  const { regionProps: rfiLogProps } = useNavRegion<HTMLTableSectionElement>({ id: "rfi-log", order: 20 })
  const rfiModalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(rfiModalRef, !!viewRfi, () => setViewRfi(null))
  const [rfiSubject, setRfiSubject]                   = useState("")
  const [rfiDescription, setRfiDescription]           = useState("")
  const [rfiSubmittedBy, setRfiSubmittedBy]           = useState("")
  const [rfiAssignedTo, setRfiAssignedTo]             = useState("")
  const [rfiDateIssued, setRfiDateIssued]             = useState(() => new Date().toISOString().slice(0, 10))
  const [rfiDueDate, setRfiDueDate]                   = useState("")
  const [rfiProjectId, setRfiProjectId]               = useState(globalProjectId)
  const [rfiSaving, setRfiSaving]                     = useState(false)
  const [rfiResponse, setRfiResponse]                 = useState("")
  const [rfiResponseStatus, setRfiResponseStatus]     = useState("")
  const [rfiRespondSaving, setRfiRespondSaving]       = useState(false)
  const [rfiQuestion, setRfiQuestion]                 = useState("")
  const [rfiReceivedFrom, setRfiReceivedFrom]         = useState("")
  const [rfiReceivedFromCustom, setRfiReceivedFromCustom] = useState("")
  const [rfiSpecSection, setRfiSpecSection]           = useState("")
  const [rfiLocation, setRfiLocation]                 = useState("")
  const [rfiScheduleImpact, setRfiScheduleImpact]     = useState("TBD")
  const [rfiCostImpact, setRfiCostImpact]             = useState("TBD")
  const [rfiFile, setRfiFile]                         = useState<File | null>(null)
  const [rfiGeneratingPdf, setRfiGeneratingPdf]       = useState(false)

  function loadRfis(pid = globalProjectId) {
    setRfisLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/rfis${qs}`)
      .then(r => r.json())
      .then(d => setRfis(d.rfis ?? []))
      .catch(() => setRfis([]))
      .finally(() => setRfisLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadRfis() }, [globalProjectId])

  // Pre-select the current global project whenever the New RFI modal opens.
  useEffect(() => { if (showNewRfi) setRfiProjectId(globalProjectId) }, [showNewRfi, globalProjectId])

  async function createRfi(e: React.FormEvent) {
    e.preventDefault()
    setRfiSaving(true)
    try {
      const receivedFrom = rfiReceivedFrom === "__other__" ? rfiReceivedFromCustom : rfiReceivedFrom
      const fields: Record<string, string> = {
        subject: rfiSubject, question: rfiQuestion, received_from: receivedFrom,
        specification_section: rfiSpecSection, location: rfiLocation,
        schedule_impact: rfiScheduleImpact, cost_impact: rfiCostImpact,
        assigned_to: rfiAssignedTo, date_issued: rfiDateIssued,
        due_date: rfiDueDate, project_id: rfiProjectId,
      }
      if (rfiFile) {
        const { path } = await presignAndUpload("submittals", "rfis", rfiFile)
        fields.file_path = path
        fields.file_name = rfiFile.name
      }
      const res = await fetch("/api/rfis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      })
      if (res.ok) {
        setShowNewRfi(false)
        setRfiSubject(""); setRfiQuestion(""); setRfiReceivedFrom(""); setRfiReceivedFromCustom("")
        setRfiSpecSection(""); setRfiLocation(""); setRfiScheduleImpact("TBD"); setRfiCostImpact("TBD")
        setRfiAssignedTo(""); setRfiDueDate(""); setRfiProjectId(""); setRfiFile(null)
        setRfiDateIssued(new Date().toISOString().slice(0, 10))
        loadRfis()
      }
    } finally { setRfiSaving(false) }
  }

  async function deleteRfi(rfiId: string) {
    if (!confirm("Delete this RFI? This cannot be undone.")) return
    await fetch(`/api/rfis/${rfiId}`, { method: "DELETE" })
    setViewRfi(null)
    loadRfis()
  }

  async function generateRfiPdf(rfiId: string) {
    setRfiGeneratingPdf(true)
    try {
      const res  = await fetch(`/api/rfis/${rfiId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) {
        window.open(data.url, "_blank")
        loadRfis()
      }
    } finally { setRfiGeneratingPdf(false) }
  }

  async function respondRfi() {
    if (!viewRfi) return
    setRfiRespondSaving(true)
    try {
      const res = await fetch(`/api/rfis/${viewRfi.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: rfiResponse, status: rfiResponseStatus }),
      })
      if (res.ok) { setViewRfi(null); setRfiResponse(""); loadRfis() }
    } finally { setRfiRespondSaving(false) }
  }

  return (
    <>
      {/* RFI action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">RFI Log <span className="text-[#64748B] font-normal ml-1">({rfis.length})</span></p>
        <button onClick={() => setShowNewRfi(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
          <PlusIcon /> New RFI
        </button>
      </div>

      {/* RFI log */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            rfisLoading ? (
              <div className="mx-4 my-4"><SkeletonTable rows={8} cols={7} /></div>
            ) : rfis.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No RFIs yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Create your first RFI to track questions and responses.</p>
                <button onClick={() => setShowNewRfi(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New RFI
                </button>
              </div>
            ) : (
              <>
              {/* Desktop table */}
              <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">RFI #</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Subject</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Received From</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Spec Section</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Sched.</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Cost</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Due</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Actions</th>
                  </tr>
                </thead>
                <tbody {...rfiLogProps}>
                  {rfis.map(r => {
                    const isOverdue = r.due_date && new Date(r.due_date) < new Date() && r.status !== "Closed" && r.status !== "Answered" && r.status !== "Void"
                    return (
                      <tr key={r.id} data-nav-item className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7B9BB5]">
                        <td className="px-4 py-2.5 text-[12px] font-mono text-[#7B9BB5]">{r.rfi_number}</td>
                        <td className="px-4 py-2.5 max-w-0">
                          <p className="text-[#0F172A] font-medium truncate" title={r.subject}>{r.subject}</p>
                          {r.description && <p className="text-[11px] text-[#64748B] truncate">{r.description}</p>}
                        </td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px] truncate">{r.received_from ?? r.submitted_by ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px] font-mono">{r.specification_section ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[12px]">
                          <span className={r.schedule_impact === "Yes" ? "text-amber-400" : r.schedule_impact === "No" ? "text-green-400" : "text-[#64748B]"}>{r.schedule_impact ?? "TBD"}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px]">
                          <span className="text-[#64748B]">{r.cost_impact ?? "TBD"}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                          {r.due_date ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>{fmtDateOnly(r.due_date)}{isOverdue ? " ⚠" : ""}</span> : <span className="text-[#64748B]">—</span>}
                        </td>
                        <td className="px-4 py-2.5"><RfiStatusBadge status={r.status} /></td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1">
                            <button data-nav-primary onClick={() => { setViewRfi(r); setRfiResponse(r.response ?? ""); setRfiResponseStatus(r.status) }}
                              className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">View</button>
                            <button onClick={() => generateRfiPdf(r.id)} disabled={rfiGeneratingPdf}
                              className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                            <button onClick={() => deleteRfi(r.id)}
                              className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {rfis.map(r => {
                  const isOverdue = r.due_date && new Date(r.due_date) < new Date() && r.status !== "Closed" && r.status !== "Answered" && r.status !== "Void"
                  return (
                    <div key={r.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <span className="text-[11px] font-mono text-[#7B9BB5] flex-shrink-0">{r.rfi_number}</span>
                        <RfiStatusBadge status={r.status} />
                      </div>
                      <p className="text-[13px] font-medium text-[#0F172A] mb-1">{r.subject}</p>
                      <p className="text-[11px] text-[#64748B] mb-1">From: {r.received_from ?? r.submitted_by ?? "—"}</p>
                      {r.due_date && <p className="text-[11px] mb-2"><span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>Due: {fmtDateOnly(r.due_date)}{isOverdue ? " ⚠" : ""}</span></p>}
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setViewRfi(r); setRfiResponse(r.response ?? ""); setRfiResponseStatus(r.status) }} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">View</button>
                        <button onClick={() => generateRfiPdf(r.id)} disabled={rfiGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                        <button onClick={() => deleteRfi(r.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              </>
            )
          )}
      </div>

      {/* ── New RFI modal ────────────────────────────────────────────────── */}
      {showNewRfi && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowNewRfi(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[580px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">New RFI</h2>
              <button onClick={() => setShowNewRfi(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createRfi} className="flex flex-col min-h-0">
              <div className="px-6 py-4 space-y-3 overflow-y-auto">
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={rfiProjectId} onChange={e => setRfiProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Subject <span className="text-red-400">*</span></label>
                  <input type="text" required value={rfiSubject} onChange={e => setRfiSubject(e.target.value)}
                    placeholder="Brief description of the question" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Question</label>
                  <textarea value={rfiQuestion} onChange={e => setRfiQuestion(e.target.value)} rows={4}
                    placeholder="Detailed question — reference specs, drawings, field conditions…"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Received From</label>
                  <select value={rfiReceivedFrom} onChange={e => setRfiReceivedFrom(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    <option value="">Select or type below…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                    <option value="__other__">Other (type name)…</option>
                  </select>
                  {rfiReceivedFrom === "__other__" && (
                    <input type="text" value={rfiReceivedFromCustom} onChange={e => setRfiReceivedFromCustom(e.target.value)}
                      placeholder="Name of subcontractor, vendor, etc." className={`${inputCls} mt-1.5`} />
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Specification Section</label>
                    <input type="text" value={rfiSpecSection} onChange={e => setRfiSpecSection(e.target.value)}
                      placeholder="e.g. 09 22 16" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Location</label>
                    <input type="text" value={rfiLocation} onChange={e => setRfiLocation(e.target.value)}
                      placeholder="Area or room" className={inputCls} />
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Schedule Impact</label>
                    <select value={rfiScheduleImpact} onChange={e => setRfiScheduleImpact(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      {["Yes","No","TBD"].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Cost Impact</label>
                    <input value={rfiCostImpact === "TBD" ? "" : rfiCostImpact} onChange={e => setRfiCostImpact(e.target.value)} placeholder="e.g. $2,500"
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Assigned To</label>
                  <select value={rfiAssignedTo} onChange={e => setRfiAssignedTo(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    <option value="">Select…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Date Issued</label>
                    <input type="date" value={rfiDateIssued} onChange={e => setRfiDateIssued(e.target.value)} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Due Date</label>
                    <input type="date" value={rfiDueDate} onChange={e => setRfiDueDate(e.target.value)} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Attach File</label>
                  <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => setRfiFile(e.target.files?.[0] ?? null)}
                    className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                <button type="button" onClick={() => setShowNewRfi(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="submit" disabled={rfiSaving || !rfiSubject.trim()}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rfiSaving && <SpinnerIcon className="h-3 w-3" />}
                  {rfiSaving ? "Creating…" : "Create RFI"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── View/Respond RFI modal ────────────────────────────────────────── */}
      {viewRfi && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setViewRfi(null) }}>
          <div ref={rfiModalRef} role="dialog" aria-modal="true" className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[12px] font-mono text-[#7B9BB5] flex-shrink-0">{viewRfi.rfi_number}</span>
                <h2 className="text-[15px] font-bold text-[#0F172A]">{viewRfi.subject}</h2>
                <RfiStatusBadge status={viewRfi.status} />
              </div>
              <button onClick={() => setViewRfi(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors ml-4 flex-shrink-0">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto">
              {/* Meta grid */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Received From", value: viewRfi.received_from ?? viewRfi.submitted_by ?? "—" },
                  { label: "Assigned To",   value: viewRfi.assigned_to ?? "—" },
                  { label: "Spec Section",  value: viewRfi.specification_section ?? "—" },
                  { label: "Location",      value: viewRfi.location ?? "—" },
                  { label: "Schedule Impact", value: viewRfi.schedule_impact ?? "TBD" },
                  { label: "Cost Impact",   value: viewRfi.cost_impact ?? "TBD" },
                  { label: "Date Issued",   value: viewRfi.date_issued ? fmtDateOnly(viewRfi.date_issued) : "—" },
                  { label: "Due Date",      value: viewRfi.due_date ? fmtDateOnly(viewRfi.due_date) : "—" },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-md bg-[#F4F5F7] px-3 py-2">
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">{label}</p>
                    <p className="text-[12px] text-[#0F172A]">{value}</p>
                  </div>
                ))}
              </div>
              {/* Question */}
              {viewRfi.description && (
                <div className="rounded-md bg-[#F4F5F7] px-3 py-2.5">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">Question</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{viewRfi.description}</p>
                </div>
              )}
              {/* Attachment */}
              {viewRfi.file_name && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#64748B]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span className="text-[#64748B]">{viewRfi.file_name}</span>
                </div>
              )}
              {viewRfi.generated_pdf_path && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                  <button onClick={() => generateRfiPdf(viewRfi.id)} className="text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">View / Regenerate PDF</button>
                </div>
              )}
              {/* Response */}
              <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
                <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Response</p>
                <textarea value={rfiResponse} onChange={e => setRfiResponse(e.target.value)} rows={4}
                  placeholder="Enter response here…"
                  className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={rfiResponseStatus} onChange={e => setRfiResponseStatus(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    {["Open","In Review","Answered","Closed","Void"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-between px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <div className="flex gap-2">
                <button onClick={() => generateRfiPdf(viewRfi.id)} disabled={rfiGeneratingPdf}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rfiGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" /> Generating…</> : "Generate PDF"}
                </button>
                <button onClick={() => deleteRfi(viewRfi.id)}
                  className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setViewRfi(null)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Close</button>
                <button onClick={respondRfi} disabled={rfiRespondSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rfiRespondSaving && <SpinnerIcon className="h-3 w-3" />}
                  {rfiRespondSaving ? "Saving…" : "Save Response"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
