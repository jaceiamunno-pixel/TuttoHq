"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { presignAndUpload } from "@/lib/storage-upload"
import { SUBMITTAL_TYPES, type SubmittalType, type BulkImportAnalysis } from "@/lib/bulk-import-detect"

// Bulk Import — Stage 1 modal. Drop many signed PDFs (or one — same engine,
// per the design's single-upload-is-batch-of-one decision). Each file is
// uploaded to a staging path and analyzed read-only. The review table
// surfaces three suggestions per row (spec section, submittal type,
// coversheet split) plus a user-entered approval date and status. No
// commit action — Stage 2 ships separately for review.

// Bounded concurrency: process N PDFs at a time so a 50-PDF batch can't OOM
// the function or saturate the user's uplink. Same lesson as the photo
// batch pipeline (DailyModule Add Photos).
const CONCURRENCY = 3

type RowStatus = "queued" | "uploading" | "analyzing" | "ready" | "error"

interface Row {
  id: string
  file: File
  status: RowStatus
  uploadPercent: number
  errorMsg?: string
  storagePath?: string
  analysis?: BulkImportAnalysis
  // User-editable overrides, seeded from the analysis. Empty strings until
  // analysis lands.
  section: string
  type: SubmittalType | ""
  coverSplit: number
  approvalDate: string  // yyyy-mm-dd, user-entered (no OCR in v1)
  reviewStatus: "Approved" | "Approved with Comments" | "Rejected" | "Revise and Resubmit"
}

function newRow(file: File): Row {
  return {
    id: crypto.randomUUID(),
    file,
    status: "queued",
    uploadPercent: 0,
    section: "",
    type: "",
    coverSplit: 0,
    approvalDate: "",
    reviewStatus: "Approved",
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

function FlagIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  )
}

export default function BulkImportModal({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  // Single-runner guard. Multiple concurrent worker pools would race the
  // same row ids; prevent another processBatch() while one is already in
  // flight (e.g. user adds files mid-run).
  const runningRef = useRef(false)

  function updateRow(id: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  const processRow = useCallback(async (id: string) => {
    // Snapshot the row from a state read — the closure can't reliably see
    // the latest after multiple updates, so grab a fresh copy through
    // setRows( prev => …).
    let row: Row | undefined
    setRows(prev => { row = prev.find(r => r.id === id); return prev })
    if (!row) return
    if (row.status !== "queued") return

    try {
      updateRow(id, { status: "uploading", uploadPercent: 0 })
      const { path } = await presignAndUpload(
        "submittals",
        "bulk-import-staging",
        row.file,
        (p) => updateRow(id, { uploadPercent: p.percent }),
      )
      updateRow(id, { storagePath: path, status: "analyzing", uploadPercent: 100 })

      const res = await fetch("/api/bulk-import/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storage_path: path, file_name: row.file.name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error ?? `Analyze failed (HTTP ${res.status})`)
      }

      const analysis = data.analysis as BulkImportAnalysis
      updateRow(id, {
        status: "ready",
        analysis,
        section: analysis.suggestedSection ?? "",
        type: analysis.suggestedType ?? "",
        coverSplit: analysis.cover.coverSplit,
      })
    } catch (err) {
      updateRow(id, {
        status: "error",
        errorMsg: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }, [])

  const runBatch = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      // Snapshot queued ids at start. Files added mid-run are picked up by
      // a subsequent runBatch() invocation (we kick one after onPickFiles).
      let queued: string[] = []
      setRows(prev => { queued = prev.filter(r => r.status === "queued").map(r => r.id); return prev })
      if (queued.length === 0) return

      // Worker pool of size CONCURRENCY drains the queue. Each worker picks
      // the next id off the shared queue until empty.
      let cursor = 0
      const worker = async () => {
        while (cursor < queued.length) {
          const i = cursor++
          await processRow(queued[i])
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queued.length) }, worker),
      )
    } finally {
      runningRef.current = false
    }
  }, [processRow])

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name))
    if (incoming.length === 0) return
    setRows(prev => [...prev, ...incoming.map(newRow)])
    // Kick the runner — guarded against concurrent passes.
    setTimeout(() => { runBatch().catch(err => console.error("[bulk-import] runBatch threw", err)) }, 0)
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    addFiles(files)
    e.currentTarget.value = ""  // allow re-pick of same file
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  function removeRow(id: string) {
    setRows(prev => prev.filter(r => r.id !== id))
  }

  // Aggregates for the footer summary.
  const totals = useMemo(() => {
    const total = rows.length
    const ready = rows.filter(r => r.status === "ready").length
    const errored = rows.filter(r => r.status === "error").length
    const inFlight = rows.filter(r => r.status === "uploading" || r.status === "analyzing").length
    const flagged = rows.filter(r => r.status === "ready" && r.analysis?.needsAttention).length
    const missingDate = rows.filter(r => r.status === "ready" && !r.approvalDate).length
    const missingSection = rows.filter(r => r.status === "ready" && !r.section).length
    const missingType = rows.filter(r => r.status === "ready" && !r.type).length
    return { total, ready, errored, inFlight, flagged, missingDate, missingSection, missingType }
  }, [rows])

  void projectId  // kept in the API for Stage 2 (project assignment on commit)

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-stretch sm:items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white sm:rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[min(96vw,1200px)] sm:max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-[16px] font-bold text-[#0F172A] leading-tight">Bulk Import — Approved Submittals</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">
              Drop signed submittal PDFs. Each row shows three suggestions to confirm: spec section, type, and where the coversheet ends.
              <span className="text-[#7B9BB5] font-semibold"> Stage 1 — review only. Nothing is committed yet.</span>
            </p>
          </div>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#0F172A] flex-shrink-0" aria-label="Close">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">

          {/* Drop / pick zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${dragOver ? "border-[#7B9BB5] bg-[#7B9BB5]/[0.06]" : "border-[#E2E8F0] bg-[#F8F9FA]"}`}
          >
            <p className="text-[13px] text-[#0F172A] font-medium">Drop signed submittal PDFs here</p>
            <p className="text-[11px] text-[#64748B] mt-1">or</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-2 h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
            >
              Choose PDFs
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={onPickFiles}
              className="hidden"
            />
            <p className="text-[11px] text-[#64748B] mt-2">Single PDF works too — runs through the same review.</p>
          </div>

          {/* Review table */}
          {rows.length > 0 && (
            <div className="rounded-lg border border-[#E2E8F0] overflow-x-auto">
              <table className="w-full text-[12px] border-collapse">
                <thead className="bg-[#F8F9FA]">
                  <tr className="text-left text-[10px] font-bold text-[#64748B] uppercase tracking-wider">
                    <th className="px-3 py-2 w-[26%]">File</th>
                    <th className="px-3 py-2 w-[15%]">Spec section</th>
                    <th className="px-3 py-2 w-[15%]">Type</th>
                    <th className="px-3 py-2 w-[12%]">Cover split</th>
                    <th className="px-3 py-2 w-[14%]">Approval date</th>
                    <th className="px-3 py-2 w-[12%]">Status</th>
                    <th className="px-3 py-2 w-[6%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const flagged = r.status === "ready" && (r.analysis?.needsAttention || !r.section || !r.type || !r.approvalDate)
                    return (
                    <tr key={r.id} className={`border-t border-[#E2E8F0] ${flagged ? "bg-amber-50/50" : ""}`}>
                      {/* File + status */}
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <p className="text-[#0F172A] truncate font-medium" title={r.file.name}>{r.file.name}</p>
                            <p className="text-[10px] text-[#64748B] mt-0.5">
                              {fmtBytes(r.file.size)}
                              {r.analysis ? ` · ${r.analysis.pageCount} pages` : ""}
                            </p>
                            {r.status === "uploading" && (
                              <p className="text-[10px] text-[#64748B] mt-1 flex items-center gap-1">
                                <Spinner className="h-3 w-3" /> Uploading… {r.uploadPercent}%
                              </p>
                            )}
                            {r.status === "analyzing" && (
                              <p className="text-[10px] text-[#64748B] mt-1 flex items-center gap-1">
                                <Spinner className="h-3 w-3" /> Reading PDF…
                              </p>
                            )}
                            {r.status === "error" && (
                              <p className="text-[10px] text-red-600 mt-1">{r.errorMsg ?? "Failed"}</p>
                            )}
                            {r.status === "ready" && r.analysis?.notes && r.analysis.notes.length > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {r.analysis.notes.map((n, i) => (
                                  <li key={i} className="text-[10px] text-amber-700 flex items-start gap-1">
                                    <FlagIcon className="h-3 w-3 flex-shrink-0 mt-0.5" />
                                    <span>{n}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Spec section — editable */}
                      <td className="px-3 py-2 align-top">
                        <input
                          type="text"
                          value={r.section}
                          onChange={e => updateRow(r.id, { section: e.target.value })}
                          placeholder={r.status === "ready" ? "XX YY ZZ" : "…"}
                          disabled={r.status !== "ready"}
                          className={`w-full h-7 px-2 rounded border text-[12px] tabular-nums ${
                            flagged && r.analysis?.sectionFlag
                              ? "border-amber-400 bg-amber-50"
                              : "border-[#E2E8F0]"
                          } disabled:opacity-50`}
                        />
                        {r.analysis?.suggestedSectionDivision && (
                          <p className="text-[10px] text-[#64748B] mt-0.5 truncate" title={r.analysis.suggestedSectionDivision}>
                            {r.analysis.suggestedSectionDivision}
                          </p>
                        )}
                      </td>

                      {/* Submittal type — fixed-vocab dropdown */}
                      <td className="px-3 py-2 align-top">
                        <select
                          value={r.type}
                          onChange={e => updateRow(r.id, { type: e.target.value as SubmittalType | "" })}
                          disabled={r.status !== "ready"}
                          className={`w-full h-7 px-1.5 rounded border text-[12px] ${
                            flagged && r.analysis?.typeFlag
                              ? "border-amber-400 bg-amber-50"
                              : "border-[#E2E8F0]"
                          } disabled:opacity-50`}
                        >
                          <option value="">— pick —</option>
                          {SUBMITTAL_TYPES.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </td>

                      {/* Coversheet split — number input */}
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={r.analysis?.pageCount ?? 9999}
                            value={r.coverSplit}
                            onChange={e => updateRow(r.id, { coverSplit: Math.max(0, parseInt(e.target.value || "0", 10)) })}
                            disabled={r.status !== "ready"}
                            className={`w-14 h-7 px-2 rounded border text-[12px] tabular-nums ${
                              flagged && r.analysis?.cover.uncertain
                                ? "border-amber-400 bg-amber-50"
                                : "border-[#E2E8F0]"
                            } disabled:opacity-50`}
                          />
                          <span className="text-[10px] text-[#64748B] whitespace-nowrap">
                            of {r.analysis?.pageCount ?? "?"}
                          </span>
                        </div>
                      </td>

                      {/* Approval date — user-entered, NO OCR in v1 */}
                      <td className="px-3 py-2 align-top">
                        <input
                          type="date"
                          value={r.approvalDate}
                          onChange={e => updateRow(r.id, { approvalDate: e.target.value })}
                          disabled={r.status !== "ready"}
                          className={`w-full h-7 px-2 rounded border text-[12px] ${
                            r.status === "ready" && !r.approvalDate
                              ? "border-amber-400 bg-amber-50"
                              : "border-[#E2E8F0]"
                          } disabled:opacity-50`}
                        />
                      </td>

                      {/* Approval status — default Approved */}
                      <td className="px-3 py-2 align-top">
                        <select
                          value={r.reviewStatus}
                          onChange={e => updateRow(r.id, { reviewStatus: e.target.value as Row["reviewStatus"] })}
                          disabled={r.status !== "ready"}
                          className="w-full h-7 px-1.5 rounded border border-[#E2E8F0] text-[12px] disabled:opacity-50"
                        >
                          <option>Approved</option>
                          <option>Approved with Comments</option>
                          <option>Rejected</option>
                          <option>Revise and Resubmit</option>
                        </select>
                      </td>

                      {/* Per-row actions */}
                      <td className="px-3 py-2 align-top text-right">
                        <button
                          onClick={() => removeRow(r.id)}
                          title="Remove from review"
                          className="text-[#64748B] hover:text-red-600 transition-colors"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer — Stage 1 has NO commit action. Just totals + Close. */}
        <div className="border-t border-[#E2E8F0] px-5 py-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-[#64748B] flex flex-wrap items-center gap-x-3 gap-y-1">
            {totals.total > 0 ? (
              <>
                <span>{totals.total} file{totals.total === 1 ? "" : "s"}</span>
                {totals.inFlight > 0 && (
                  <span className="flex items-center gap-1"><Spinner className="h-3 w-3" /> {totals.inFlight} processing</span>
                )}
                {totals.ready > 0 && <span>{totals.ready} ready</span>}
                {totals.errored > 0 && <span className="text-red-600">{totals.errored} failed</span>}
                {totals.flagged > 0 && (
                  <span className="flex items-center gap-1 text-amber-700">
                    <FlagIcon className="h-3 w-3" /> {totals.flagged} need review
                  </span>
                )}
                {(totals.missingDate + totals.missingSection + totals.missingType) > 0 && (
                  <span className="text-amber-700">
                    Missing: {[
                      totals.missingDate > 0 ? `${totals.missingDate} date${totals.missingDate === 1 ? "" : "s"}` : null,
                      totals.missingSection > 0 ? `${totals.missingSection} section${totals.missingSection === 1 ? "" : "s"}` : null,
                      totals.missingType > 0 ? `${totals.missingType} type${totals.missingType === 1 ? "" : "s"}` : null,
                    ].filter(Boolean).join(" · ")}
                  </span>
                )}
              </>
            ) : (
              <span>Drop PDFs to start.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              title="Stage 2 (commit to log + library) ships separately for review."
              className="text-[11px] text-[#64748B] italic">
              Commit step coming after Stage 1 review
            </span>
            <button
              onClick={onClose}
              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
