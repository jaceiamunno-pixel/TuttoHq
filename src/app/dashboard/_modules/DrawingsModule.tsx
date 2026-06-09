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

// Discipline options for the sheet metadata edit (mirrors drawing-detect's map).
const SHEET_DISCIPLINES = ["Architectural", "Structural", "Mechanical", "Electrical", "Plumbing", "Civil", "Fire Protection", "Demolition", "Landscape", "General", "Telecom"]

// Committed drawing_sheets (ADR-005 Drawing Log v1).
interface ImportedSheet {
  id: string
  sheet_number: string | null
  discipline: string | null
  discipline_prefix: string | null
  title: string | null
  revision_label: string | null
  file_url: string | null
  created_at: string
  deleted_at?: string | null
  days_remaining?: number | null
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
  const [viewerSheet, setViewerSheet]                 = useState<ImportedSheet | null>(null)
  const [viewerFull, setViewerFull]                   = useState(false)
  const [editingSheetId, setEditingSheetId]           = useState<string | null>(null)
  const [sheetDraft, setSheetDraft]                   = useState({ sheet_number: "", title: "", discipline: "", discipline_prefix: "", revision_label: "" })
  const [savingSheet, setSavingSheet]                 = useState(false)
  const [showDeleted, setShowDeleted]                 = useState(false)
  const [deletedSheets, setDeletedSheets]             = useState<ImportedSheet[]>([])
  const [deletedLoading, setDeletedLoading]           = useState(false)
  const [sheetSearch, setSheetSearch]                 = useState("")
  const [disciplineFilter, setDisciplineFilter]       = useState("")

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

  function startEditSheet(s: ImportedSheet) {
    setEditingSheetId(s.id)
    setSheetDraft({
      sheet_number: s.sheet_number ?? "", title: s.title ?? "",
      discipline: s.discipline ?? "", discipline_prefix: s.discipline_prefix ?? "",
      revision_label: s.revision_label ?? "",
    })
  }
  async function saveEditSheet(id: string) {
    if (!sheetDraft.sheet_number.trim()) { alert("Sheet number cannot be blank."); return }
    setSavingSheet(true)
    try {
      const res = await fetch(`/api/drawings/sheets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sheetDraft),
      })
      if (res.ok) { setEditingSheetId(null); loadImportedSheets() }
      else { const d = await res.json().catch(() => ({})); alert(d?.error ?? "Save failed") }
    } finally { setSavingSheet(false) }
  }

  function loadDeletedSheets(pid = globalProjectId) {
    if (!pid) { setDeletedSheets([]); return }
    setDeletedLoading(true)
    fetch(`/api/drawings/sheets?project_id=${encodeURIComponent(pid)}&deleted=true`)
      .then(r => r.json())
      .then(d => setDeletedSheets(d.sheets ?? []))
      .catch(() => setDeletedSheets([]))
      .finally(() => setDeletedLoading(false))
  }

  async function softDeleteSheet(s: ImportedSheet) {
    if (!confirm(`Delete sheet ${s.sheet_number ?? ""}? It moves to Recently deleted and is permanently removed after 5 days.`)) return
    const res = await fetch(`/api/drawings/sheets/${s.id}`, { method: "DELETE" })
    if (res.ok) { loadImportedSheets(); if (showDeleted) loadDeletedSheets() }
    else { const d = await res.json().catch(() => ({})); alert(d?.error ?? "Delete failed") }
  }
  async function restoreSheet(s: ImportedSheet) {
    const res = await fetch(`/api/drawings/sheets/${s.id}/restore`, { method: "POST" })
    if (res.ok) { loadDeletedSheets(); loadImportedSheets() }
    else { const d = await res.json().catch(() => ({})); alert(d?.error ?? "Restore failed") }
  }
  function toggleDeleted() {
    const next = !showDeleted
    setShowDeleted(next)
    if (next) loadDeletedSheets()
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDrawings(); loadImportedSheets(); loadDeletedSheets(); setShowDeleted(false) }, [globalProjectId])

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

  // Imported-sheets search + discipline filter (client-side over the loaded,
  // already tenant-scoped list — no new data exposure). Both active = AND.
  const availableDisciplines = Array.from(
    new Set(importedSheets.map(s => s.discipline).filter((d): d is string => !!d)),
  ).sort()
  const sheetQuery = sheetSearch.trim().toLowerCase()
  const visibleSheets = importedSheets.filter(s => {
    if (disciplineFilter && s.discipline !== disciplineFilter) return false
    if (!sheetQuery) return true
    return [s.sheet_number, s.title, s.discipline_prefix]
      .some(v => (v ?? "").toLowerCase().includes(sheetQuery))
  })

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
          {(importedLoading || importedSheets.length > 0 || deletedSheets.length > 0) && (
            <div className="px-4 pt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-semibold text-[#0F172A]">
                  Imported sheets <span className="text-[#64748B] font-normal">({importedSheets.length})</span>
                </p>
                {deletedSheets.length > 0 && (
                  <button onClick={toggleDeleted} className="text-[11px] text-[#64748B] hover:text-[#0F172A] font-semibold">
                    {showDeleted ? "Hide" : "Show"} recently deleted ({deletedSheets.length})
                  </button>
                )}
              </div>
              {!importedLoading && importedSheets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input
                    value={sheetSearch}
                    onChange={e => setSheetSearch(e.target.value)}
                    placeholder="Search sheet #, title, prefix…"
                    className="h-7 px-2 rounded border border-[#E2E8F0] text-[12px] w-56 focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                  />
                  <select value={disciplineFilter} onChange={e => setDisciplineFilter(e.target.value)}
                    className="h-7 px-2 rounded border border-[#E2E8F0] text-[12px] bg-white">
                    <option value="">All disciplines</option>
                    {availableDisciplines.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                  {(sheetQuery || disciplineFilter) && (
                    <>
                      <span className="text-[11px] text-[#64748B]">{visibleSheets.length} of {importedSheets.length}</span>
                      <button onClick={() => { setSheetSearch(""); setDisciplineFilter("") }}
                        className="text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold">Clear</button>
                    </>
                  )}
                </div>
              )}
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
                        <th className="px-3 py-2 w-40 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSheets.length === 0 && (
                        <tr><td colSpan={5} className="px-3 py-3 text-[12px] text-[#94A3B8]">No sheets match the current search/filter.</td></tr>
                      )}
                      {visibleSheets.map(s => editingSheetId === s.id ? (
                        <tr key={s.id} className="border-t border-[#F1F5F9] bg-[#F8FAFC]">
                          <td className="px-2 py-1.5">
                            <input value={sheetDraft.sheet_number} onChange={e => setSheetDraft(d => ({ ...d, sheet_number: e.target.value }))}
                              className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px] font-mono" placeholder="Sheet #" />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <select value={sheetDraft.discipline} onChange={e => setSheetDraft(d => ({ ...d, discipline: e.target.value }))}
                                className="flex-1 h-7 px-1 rounded border border-[#E2E8F0] text-[12px] bg-white">
                                <option value="">—</option>
                                {SHEET_DISCIPLINES.map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                              <input value={sheetDraft.discipline_prefix} onChange={e => setSheetDraft(d => ({ ...d, discipline_prefix: e.target.value }))}
                                className="w-10 h-7 px-1 rounded border border-[#E2E8F0] text-[12px] font-mono" title="Raw prefix" placeholder="pfx" />
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={sheetDraft.title} onChange={e => setSheetDraft(d => ({ ...d, title: e.target.value }))}
                              className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px]" placeholder="Title" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={sheetDraft.revision_label} onChange={e => setSheetDraft(d => ({ ...d, revision_label: e.target.value }))}
                              className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px]" placeholder="Rev" />
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            <button onClick={() => saveEditSheet(s.id)} disabled={savingSheet}
                              className="text-[#5A7A94] font-semibold hover:text-[#3F5A70] disabled:opacity-50">Save</button>
                            <button onClick={() => setEditingSheetId(null)} className="ml-3 text-[#64748B] hover:text-[#0F172A]">Cancel</button>
                          </td>
                        </tr>
                      ) : (
                        <tr key={s.id} className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC]">
                          <td className="px-3 py-1.5 font-mono font-semibold text-[#5A7A94]">
                            <button onClick={() => { setViewerSheet(s); setViewerFull(false) }} className="hover:underline" title="View sheet">{s.sheet_number ?? "—"}</button>
                          </td>
                          <td className="px-3 py-1.5 text-[#0F172A]">{s.discipline ?? (s.discipline_prefix ? `(${s.discipline_prefix})` : "—")}</td>
                          <td className="px-3 py-1.5 text-[#0F172A] truncate max-w-0">{s.title ?? <span className="text-[#94A3B8]">—</span>}</td>
                          <td className="px-3 py-1.5 text-[#64748B]">{s.revision_label ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            <button onClick={() => { setViewerSheet(s); setViewerFull(false) }} className="text-[#7B9BB5] hover:text-[#5A7A94] font-semibold">View</button>
                            <button onClick={() => startEditSheet(s)} className="ml-3 text-[#7B9BB5] hover:text-[#5A7A94] font-semibold">Edit</button>
                            <button onClick={() => softDeleteSheet(s)} className="ml-3 text-red-400 hover:text-red-500 font-semibold">Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Recently deleted — soft-deleted sheets within the 5-day
                  recovery window; restorable until the scheduled purge. */}
              {showDeleted && (
                <div className="mt-4">
                  <p className="text-[12px] font-semibold text-[#0F172A] mb-2">Recently deleted <span className="text-[#64748B] font-normal">({deletedSheets.length})</span></p>
                  {deletedLoading ? (
                    <div className="flex items-center gap-2 text-[12px] text-[#64748B] py-3"><SpinnerIcon className="h-4 w-4" /> Loading…</div>
                  ) : deletedSheets.length === 0 ? (
                    <p className="text-[12px] text-[#94A3B8] py-2">Nothing in the trash.</p>
                  ) : (
                    <div className="overflow-x-auto border border-amber-200 rounded-lg bg-amber-50/40">
                      <table className="w-full text-[12px]">
                        <thead className="bg-amber-50 text-amber-800">
                          <tr className="text-left">
                            <th className="px-3 py-2 w-28">Sheet #</th>
                            <th className="px-3 py-2">Title</th>
                            <th className="px-3 py-2 w-36">Time left</th>
                            <th className="px-3 py-2 w-24 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deletedSheets.map(s => (
                            <tr key={s.id} className="border-t border-amber-100">
                              <td className="px-3 py-1.5 font-mono font-semibold text-[#5A7A94]">{s.sheet_number ?? "—"}</td>
                              <td className="px-3 py-1.5 text-[#0F172A] truncate max-w-0">{s.title ?? <span className="text-[#94A3B8]">—</span>}</td>
                              <td className="px-3 py-1.5 text-amber-700">
                                {s.days_remaining != null ? `${s.days_remaining} day${s.days_remaining === 1 ? "" : "s"} left` : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                <button onClick={() => restoreSheet(s)} className="text-[#5A7A94] hover:text-[#3F5A70] font-semibold">Restore</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
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

      {/* ── Sheet viewer (read-only PDF preview + full-screen) ───────────── */}
      {viewerSheet && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewerSheet(null) }}>
          <div className={`bg-white shadow-2xl flex flex-col ${viewerFull ? "fixed inset-2 rounded-lg" : "w-[88vw] h-[88vh] rounded-xl"}`}>
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-[#E2E8F0]">
              <p className="text-[13px] font-semibold text-[#0F172A] truncate">
                <span className="font-mono text-[#5A7A94]">{viewerSheet.sheet_number ?? "—"}</span>
                {viewerSheet.title ? <span className="text-[#64748B] font-normal ml-2">{viewerSheet.title}</span> : null}
                {viewerSheet.revision_label ? <span className="text-[#94A3B8] font-normal ml-2">· {viewerSheet.revision_label}</span> : null}
              </p>
              <div className="flex items-center gap-3 flex-shrink-0">
                {viewerSheet.file_url && (
                  <a href={viewerSheet.file_url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold">Open in new tab</a>
                )}
                <button onClick={() => setViewerFull(f => !f)} className="text-[12px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold">
                  {viewerFull ? "Exit full screen" : "Full screen"}
                </button>
                <button onClick={() => setViewerSheet(null)} className="text-[#64748B] hover:text-[#0F172A]"><XIcon className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 min-h-0 bg-[#F1F3F5]">
              {viewerSheet.file_url
                ? <iframe src={`${viewerSheet.file_url}#view=Fit`} title={viewerSheet.sheet_number ?? "sheet"} className="w-full h-full border-none" />
                : <div className="flex items-center justify-center h-full text-[13px] text-[#94A3B8]">No file attached to this sheet.</div>}
            </div>
          </div>
        </div>
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
