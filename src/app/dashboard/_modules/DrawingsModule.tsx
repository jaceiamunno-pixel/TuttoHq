"use client"

import { useState, useEffect, useRef } from "react"
import type { DrawingRecord, Project } from "../_shared/types"
import { fmtDate, nextRevision } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { DrawingStatusBadge } from "../_shared/badges"
import { inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"
import dynamic from "next/dynamic"

// Lazy-loaded: the splitter pulls in pdf-lib + unpdf (~180 kB). Code-split so
// those load only when a user actually opens the import modal, keeping the
// dashboard's first-load JS lean. Client-only (browser crypto/File APIs).
const DrawingImportModal = dynamic(() => import("@/components/drawings/DrawingImportModal"), { ssr: false })

// Committed drawing_sheets (ADR-005 Drawing Log v1) — read/display only.
interface ImportedSheet {
  id: string
  sheet_number: string | null
  discipline: string | null
  discipline_prefix: string | null
  title: string | null
  revision_label: string | null
  file_url: string | null
  created_at: string
}

// Drawing Log module — extracted verbatim from dashboard/page.tsx (Step 1 of the split).
// State, handlers, action bar, content, and modal are unchanged; the only
// difference is the load effect keys on globalProjectId (the module mounts only
// when the Drawing Log is active, so the activeModule guard is no longer needed).

export default function DrawingsModule({ globalProjectId, appProjects }: {
  globalProjectId: string
  appProjects: Project[]
}) {
  // Drawing log
  const [drawings, setDrawings]                       = useState<DrawingRecord[]>([])
  const [drawingsLoading, setDrawingsLoading]         = useState(false)
  const [showNewDrawing, setShowNewDrawing]           = useState(false)
  const [addRevisionFor, setAddRevisionFor]           = useState<DrawingRecord | null>(null)
  const [expandedDrawings, setExpandedDrawings]       = useState<Set<string>>(new Set())
  const [dwgNumber, setDwgNumber]                     = useState("")
  const [dwgTitle, setDwgTitle]                       = useState("")
  const [dwgDiscipline, setDwgDiscipline]             = useState("")
  const [dwgRevision, setDwgRevision]                 = useState("0")
  const [dwgRevDate, setDwgRevDate]                   = useState("")
  const [dwgStatus, setDwgStatus]                     = useState("Issued for Review")
  const [dwgScale, setDwgScale]                       = useState("")
  const [dwgNotes, setDwgNotes]                       = useState("")
  const [dwgProjectId, setDwgProjectId]               = useState(globalProjectId)
  const dwgFileRef    = useRef<HTMLInputElement>(null)
  const [dwgSaving, setDwgSaving]                     = useState(false)
  const [drawingGeneratingPdf, setDrawingGeneratingPdf] = useState(false)
  const [showImportSet, setShowImportSet]             = useState(false)
  const [importedSheets, setImportedSheets]           = useState<ImportedSheet[]>([])
  const [importedLoading, setImportedLoading]         = useState(false)

  function loadDrawings(pid = globalProjectId) {
    setDrawingsLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/drawings${qs}`)
      .then(r => r.json())
      .then(d => setDrawings(d.drawings ?? []))
      .catch(() => setDrawings([]))
      .finally(() => setDrawingsLoading(false))
  }

  // Committed drawing_sheets (splitter output). Separate read from the legacy
  // drawing_log above — different data model, different table.
  function loadImportedSheets(pid = globalProjectId) {
    if (!pid) { setImportedSheets([]); return }
    setImportedLoading(true)
    fetch(`/api/drawings/sheets?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setImportedSheets(d.sheets ?? []))
      .catch(() => setImportedSheets([]))
      .finally(() => setImportedLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDrawings(); loadImportedSheets() }, [globalProjectId])

  // Pre-select the current global project whenever the New Drawing modal opens.
  useEffect(() => { if (showNewDrawing) setDwgProjectId(globalProjectId) }, [showNewDrawing, globalProjectId])

  function openAddRevision(d: DrawingRecord) {
    setAddRevisionFor(d)
    setDwgNumber(d.drawing_number)
    setDwgTitle(d.sheet_title)
    setDwgDiscipline(d.discipline ?? "")
    setDwgRevision(nextRevision(d.revision))
    setDwgRevDate("")
    setDwgStatus(d.status)
    setDwgScale(d.scale ?? "")
    setDwgNotes("")
    setDwgProjectId(d.project_id ?? "")
  }

  function resetDwgForm() {
    setDwgNumber(""); setDwgTitle(""); setDwgDiscipline(""); setDwgRevision("0")
    setDwgRevDate(""); setDwgStatus("Issued for Review"); setDwgScale(""); setDwgNotes(""); setDwgProjectId("")
  }

  async function createDrawing(e: React.FormEvent) {
    e.preventDefault()
    setDwgSaving(true)
    try {
      const fields: Record<string, string> = { drawing_number: dwgNumber, sheet_title: dwgTitle, discipline: dwgDiscipline, revision: dwgRevision, revision_date: dwgRevDate, status: dwgStatus, scale: dwgScale, notes: dwgNotes, project_id: dwgProjectId }
      const dwgFile = dwgFileRef.current?.files?.[0]
      if (dwgFile) {
        const { path } = await presignAndUpload("submittals", "drawings", dwgFile)
        fields.file_path = path
        fields.file_name = dwgFile.name
      }
      const res = await fetch("/api/drawings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      })
      if (res.ok) {
        setShowNewDrawing(false); setAddRevisionFor(null); resetDwgForm(); loadDrawings()
        // Collapse revision history so updated row is visible
        setExpandedDrawings(prev => { const n = new Set(prev); n.delete(dwgNumber); return n })
      }
    } finally { setDwgSaving(false) }
  }

  async function deleteDrawing(drawingId: string) {
    if (!confirm("Delete this drawing and all its revisions? This cannot be undone.")) return
    await fetch(`/api/drawings/${drawingId}`, { method: "DELETE" })
    loadDrawings()
  }

  async function generateDrawingPdf(drawingId: string) {
    setDrawingGeneratingPdf(true)
    try {
      const res = await fetch(`/api/drawings/${drawingId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadDrawings() }
    } finally { setDrawingGeneratingPdf(false) }
  }

  return (
    <>
      {/* Drawing log action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5">
        <p className="text-[13px] font-semibold text-[#0F172A]">Drawing Log <span className="text-[#64748B] font-normal ml-1">({drawings.filter(d => d.is_current).length} sheets)</span></p>
        <div className="flex items-center gap-2">
          {globalProjectId && (
            <button onClick={() => setShowImportSet(true)} className="h-8 px-4 rounded-md border border-[#7B9BB5] text-[#5A7A94] text-[13px] font-semibold hover:bg-[#7B9BB5]/10 transition-colors flex items-center gap-1.5">
              Import set / Split
            </button>
          )}
          <button onClick={() => { setShowNewDrawing(true); setAddRevisionFor(null); resetDwgForm() }} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5">
            <PlusIcon /> Add Drawing
          </button>
        </div>
      </div>

      {/* Drawing log */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {/* Imported sheets (drawing_sheets — splitter output). Read/display
              only; sits above the legacy manual Drawing Log cards. */}
          {(importedLoading || importedSheets.length > 0) && (
            <div className="px-4 pt-4">
              <p className="text-[12px] font-semibold text-[#0F172A] mb-2">
                Imported sheets <span className="text-[#64748B] font-normal">({importedSheets.length})</span>
              </p>
              {importedLoading ? (
                <div className="flex items-center gap-2 text-[12px] text-[#64748B] py-3"><SpinnerIcon className="h-4 w-4" /> Loading…</div>
              ) : (
                <div className="overflow-x-auto border border-[#E2E8F0] rounded-lg">
                  <table className="w-full text-[12px]">
                    <thead className="bg-[#F8FAFC] text-[#64748B]">
                      <tr className="text-left">
                        <th className="px-3 py-2 w-28">Sheet #</th>
                        <th className="px-3 py-2 w-36">Discipline</th>
                        <th className="px-3 py-2">Title</th>
                        <th className="px-3 py-2 w-24">Revision</th>
                        <th className="px-3 py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {importedSheets.map(s => (
                        <tr key={s.id} className="border-t border-[#F1F5F9]">
                          <td className="px-3 py-1.5 font-mono font-semibold text-[#5A7A94]">{s.sheet_number ?? "—"}</td>
                          <td className="px-3 py-1.5 text-[#0F172A]">{s.discipline ?? (s.discipline_prefix ? `(${s.discipline_prefix})` : "—")}</td>
                          <td className="px-3 py-1.5 text-[#0F172A] truncate max-w-0">{s.title ?? <span className="text-[#94A3B8]">—</span>}</td>
                          <td className="px-3 py-1.5 text-[#64748B]">{s.revision_label ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right">
                            {s.file_url
                              ? <a href={s.file_url} target="_blank" rel="noopener noreferrer" className="text-[#7B9BB5] hover:text-[#5A7A94] font-semibold">Open</a>
                              : <span className="text-[#CBD5E1]">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {(() => {
            const currentDrawings = drawings.filter(d => d.is_current)
            const allSuperseded   = drawings.filter(d => !d.is_current)
            return drawingsLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : currentDrawings.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No drawings yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Add drawings to track revisions and status.</p>
                <button onClick={() => { setShowNewDrawing(true); setAddRevisionFor(null); resetDwgForm() }} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> Add Drawing
                </button>
              </div>
            ) : (
              <div className="px-4 py-4">
                <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                  {currentDrawings.map(d => {
                    const history = allSuperseded.filter(s => s.drawing_number === d.drawing_number)
                    const isExpanded = expandedDrawings.has(d.drawing_number)
                    const isImg = /\.(png|jpg|jpeg|gif|webp)$/i.test(d.file_name ?? "")
                    const isPdf = /\.pdf$/i.test(d.file_name ?? "")
                    return (
                      <div key={d.id} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden flex flex-col shadow-sm">
                        {/* Preview */}
                        <div className="relative bg-[#F1F3F5] overflow-hidden" style={{ height: 180 }}>
                          {d.file_url && isImg && (
                            <img src={d.file_url} alt={d.sheet_title} className="w-full h-full object-contain" />
                          )}
                          {d.file_url && isPdf && (
                            <div className="w-full h-full overflow-hidden">
                              <iframe
                                src={`${d.file_url}#toolbar=0&navpanes=0&scrollbar=0&view=Fit`}
                                title={d.sheet_title}
                                style={{ width: "200%", height: "200%", transform: "scale(0.5)", transformOrigin: "0 0", border: "none", pointerEvents: "none" }}
                              />
                            </div>
                          )}
                          {(!d.file_url || (!isImg && !isPdf)) && (
                            <div className="flex flex-col items-center justify-center h-full gap-2">
                              <svg className="w-8 h-8 text-[#94A3B8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              <span className="text-[11px] text-[#94A3B8]">No file attached</span>
                            </div>
                          )}
                          {/* Revision history toggle */}
                          {history.length > 0 && (
                            <button
                              onClick={() => setExpandedDrawings(prev => { const n = new Set(prev); isExpanded ? n.delete(d.drawing_number) : n.add(d.drawing_number); return n })}
                              className="absolute top-1.5 left-1.5 bg-black/50 hover:bg-black/70 text-white text-[9px] font-bold px-1.5 py-0.5 rounded transition-colors"
                            >{history.length} rev</button>
                          )}
                        </div>

                        {/* Info */}
                        <div className="p-2.5 flex flex-col gap-1 flex-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-mono font-bold text-[#7B9BB5] truncate">{d.drawing_number}</span>
                            <span className="text-[10px] text-[#64748B] flex-shrink-0">Rev {d.revision}</span>
                          </div>
                          <p className="text-[12px] font-medium text-[#0F172A] leading-tight line-clamp-2">{d.sheet_title}</p>
                          <div className="mt-auto pt-1">
                            <DrawingStatusBadge status={d.status} />
                          </div>
                          <div className="flex items-center gap-1 pt-1 border-t border-[#E2E8F0] mt-1">
                            <button onClick={() => openAddRevision(d)} className="flex-1 text-[10px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold py-1 hover:bg-[#F8F9FA] rounded transition-colors text-center">+ Rev</button>
                            <button onClick={() => generateDrawingPdf(d.id)} disabled={drawingGeneratingPdf} className="flex-1 text-[10px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold py-1 hover:bg-[#F8F9FA] rounded transition-colors disabled:opacity-40 text-center">PDF</button>
                            {d.file_url && (
                              <a href={d.file_url} target="_blank" rel="noopener noreferrer" className="flex-1 text-[10px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold py-1 hover:bg-[#F8F9FA] rounded transition-colors text-center">Open</a>
                            )}
                            <button onClick={e => { e.stopPropagation(); deleteDrawing(d.id) }} className="flex-1 text-[10px] text-red-400 hover:text-red-500 font-semibold py-1 hover:bg-red-50 rounded transition-colors text-center">Del</button>
                          </div>
                        </div>

                        {/* Revision history */}
                        {isExpanded && history.length > 0 && (
                          <div className="border-t border-[#E2E8F0] bg-[#F8F9FA] px-2.5 py-2 space-y-1">
                            {history.map(h => (
                              <div key={h.id} className="flex items-center justify-between text-[10px] text-[#64748B]">
                                <span className="font-mono">Rev {h.revision}</span>
                                <span>Superseded {h.superseded_at ? fmtDate(h.superseded_at) : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
      </div>

      {/* ── Import drawing set (split + confirm) ─────────────────────────── */}
      {showImportSet && globalProjectId && (
        <DrawingImportModal projectId={globalProjectId} onClose={() => { setShowImportSet(false); loadImportedSheets() }} />
      )}

      {/* ── New Drawing / Add Revision modal ─────────────────────────────── */}
      {(showNewDrawing || addRevisionFor) && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) { setShowNewDrawing(false); setAddRevisionFor(null) } }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[560px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
            <div className="flex-shrink-0 flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <div>
                <h2 className="text-[15px] font-bold text-[#0F172A]">{addRevisionFor ? "Add Revision" : "Add Drawing"}</h2>
                {addRevisionFor && <p className="text-[12px] text-[#64748B] mt-0.5">Supersedes {addRevisionFor.drawing_number} Rev {addRevisionFor.revision}</p>}
              </div>
              <button onClick={() => { setShowNewDrawing(false); setAddRevisionFor(null) }} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createDrawing} className="flex flex-col flex-1 min-h-0">
              <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Drawing Number <span className="text-red-400">*</span></label>
                    <input type="text" required value={dwgNumber} onChange={e => setDwgNumber(e.target.value)}
                      placeholder="e.g. A-101" readOnly={!!addRevisionFor} autoFocus={!addRevisionFor}
                      className={`${inputCls} ${addRevisionFor ? "opacity-60 cursor-not-allowed" : ""}`} />
                  </div>
                  <div className="w-24 flex-shrink-0">
                    <label className={labelCls}>Revision <span className="text-red-400">*</span></label>
                    <input type="text" required value={dwgRevision} onChange={e => setDwgRevision(e.target.value)}
                      placeholder="0" autoFocus={!!addRevisionFor} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Sheet Title <span className="text-red-400">*</span></label>
                  <input type="text" required value={dwgTitle} onChange={e => setDwgTitle(e.target.value)}
                    placeholder="e.g. First Floor Plan" className={inputCls} />
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Discipline</label>
                    <select value={dwgDiscipline} onChange={e => setDwgDiscipline(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">Select…</option>
                      {["Architectural","Structural","Mechanical","Electrical","Plumbing","Civil","Landscape","Fire Protection","Low Voltage","General"].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Status</label>
                    <select value={dwgStatus} onChange={e => setDwgStatus(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      {["Issued for Construction","Issued for Bid","Issued for Review","Record Drawings","Void"].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Revision Date</label>
                    <input type="date" value={dwgRevDate} onChange={e => setDwgRevDate(e.target.value)} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Scale</label>
                    <input type="text" value={dwgScale} onChange={e => setDwgScale(e.target.value)} placeholder='e.g. 1/4" = 1&apos;-0"' className={inputCls} />
                  </div>
                </div>
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={dwgProjectId} onChange={e => setDwgProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea rows={2} value={dwgNotes} onChange={e => setDwgNotes(e.target.value)}
                    placeholder="Revision notes, changes from previous…"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                  <input ref={dwgFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button type="button" onClick={() => { setShowNewDrawing(false); setAddRevisionFor(null) }}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={dwgSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {dwgSaving && <SpinnerIcon className="h-3 w-3" />}
                  {dwgSaving ? "Saving…" : addRevisionFor ? "Add Revision" : "Add Drawing"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
