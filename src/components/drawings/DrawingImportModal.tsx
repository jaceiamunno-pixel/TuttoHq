"use client"

import { useState, useRef, useCallback } from "react"
import { PDFDocument } from "pdf-lib"
import { getDocumentProxy } from "unpdf"
import {
  detectSheetNumber, detectRevision, titleblockPayload, deriveDiscipline,
  DISCIPLINE_MAP, type PositionedItem, type PageGeom,
} from "@/lib/drawing-detect"
import { presignAndUpload } from "@/lib/storage-upload"
import { bufferToHex } from "@/lib/file-hash"
import { SpinnerIcon, XIcon } from "../../app/dashboard/_shared/icons"

// Drawing Log splitter — confirm-first import (ADR-005 Subsystem 1).
//
// CLIENT splits the uploaded set per page with pdf-lib (dodges Vercel's
// 4.5 MB body limit + server OOM), extracts each page's positioned text with
// unpdf, runs the PURE deterministic detectors (sheet#/prefix/discipline/
// revision) from drawing-detect, uploads each per-sheet PDF straight to a
// tenant-isolated drawing-staging path via presigned URL, then asks the
// title-only AI route for the fuzzy sheet title. Proposed rows live in
// component state for the editable review table. Nothing becomes canonical
// until the user hits Commit (→ /api/drawings/commit, which re-verifies
// SHA-256 server-side). Cancel purges the staged files.

const DISCIPLINE_OPTIONS = Array.from(new Set(Object.values(DISCIPLINE_MAP)))

interface ProposedRow {
  id: string
  page: number
  sheetNumber: string
  prefix: string | null
  discipline: string
  title: string
  revisionLabel: string
  include: boolean
  stagingPath: string
  sha256: string
  size: number
  flags: string[]
}

/** Apply a pdf.js 6-matrix to a point (item origin → device space). */
function applyTransform(x: number, y: number, m: number[]): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]
}

export default function DrawingImportModal({ projectId, onClose }: {
  projectId: string
  onClose: () => void
}) {
  const [phase, setPhase] = useState<"idle" | "processing" | "review" | "committing" | "done">("idle")
  const [progress, setProgress] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<ProposedRow[]>([])
  const [batchId, setBatchId] = useState<string>("")
  const [committedCount, setCommittedCount] = useState(0)
  const [failedRows, setFailedRows] = useState<{ row: ProposedRow; error: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const updateRow = useCallback((id: string, patch: Partial<ProposedRow>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }, [])

  async function processSet() {
    const file = fileRef.current?.files?.[0]
    if (!file) { setError("Choose a drawing-set PDF first."); return }
    setError(null)
    setPhase("processing")
    const bid = crypto.randomUUID()
    setBatchId(bid)
    try {
      // COPY-PER-CONSUMER: pdf.js (getDocumentProxy) takes ownership of and
      // DETACHES the Uint8Array's ArrayBuffer when it parses. Sharing one
      // buffer with pdf-lib left PDFDocument.load() reading a neutered buffer
      // → "No PDF header found at offset 0". Hand each parser its own clone.
      const ab = await file.arrayBuffer()
      const bytesForPdfjs  = new Uint8Array(ab.slice(0))
      const bytesForPdfLib = new Uint8Array(ab.slice(0))

      // Positioned text for every page (unpdf → pdf.js text content). The
      // per-page path below uses pdf.getPage() on this parsed proxy — it never
      // re-reads bytesForPdfjs, so the detach affects nothing downstream.
      setProgress("Reading drawing set…")
      const pdf = await getDocumentProxy(bytesForPdfjs)
      const pageCount = pdf.numPages

      // pdf-lib source for splitting. copyPages() below reads from this parsed
      // srcDoc, not from bytesForPdfLib, so it is likewise unaffected.
      const srcDoc = await PDFDocument.load(bytesForPdfLib)

      const staged: ProposedRow[] = []
      const titleReq: { client_row_id: string; titleblock_text: string }[] = []

      for (let p = 1; p <= pageCount; p++) {
        setProgress(`Detecting & staging sheet ${p} of ${pageCount}…`)

        // --- positioned text for page p ---
        const page = await pdf.getPage(p)
        const vp = page.getViewport({ scale: 1 })
        const geom: PageGeom = { width: vp.width, height: vp.height }
        const tc = await page.getTextContent()
        const items: PositionedItem[] = []
        let fullText = ""
        for (const it of tc.items) {
          const anyIt = it as { str?: string; transform?: number[] }
          if (typeof anyIt.str !== "string" || !anyIt.str.trim() || !anyIt.transform) continue
          const [dx, dy] = applyTransform(anyIt.transform[4], anyIt.transform[5], vp.transform as number[])
          items.push({ str: anyIt.str, x: dx, y: dy })
          fullText += anyIt.str + " "
        }

        // --- deterministic detection (pure) ---
        const sn = detectSheetNumber(items, geom)
        const rev = detectRevision(fullText, file.name)
        const tbText = titleblockPayload(items, geom, sn.sheetNumber)

        // --- split this page out (pdf-lib) ---
        const sub = await PDFDocument.create()
        const [copied] = await sub.copyPages(srcDoc, [p - 1])
        sub.addPage(copied)
        const saved = await sub.save()
        // Copy into a plain ArrayBuffer so the bytes type as BufferSource /
        // BlobPart (pdf-lib's save() returns Uint8Array<ArrayBufferLike>).
        const ab = new ArrayBuffer(saved.byteLength)
        new Uint8Array(ab).set(saved)
        const sha = bufferToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ab)))
        const pageFile = new File([ab], `${p}.pdf`, { type: "application/pdf" })

        // --- upload to tenant-isolated staging ---
        const { path } = await presignAndUpload("submittals", `drawing-staging/${bid}`, pageFile)

        const flags: string[] = []
        if (!sn.sheetNumber) flags.push("no sheet #")
        if (sn.prefix && !sn.discipline) flags.push(`prefix '${sn.prefix}' unmapped`)
        if (items.length < 5) flags.push("low text (image?)")

        const id = `${bid}-${p}`
        staged.push({
          id, page: p,
          sheetNumber: sn.sheetNumber ?? "",
          prefix: sn.prefix,
          discipline: sn.discipline ?? "",
          title: "",
          revisionLabel: rev.label,
          include: true,
          stagingPath: path,
          sha256: sha,
          size: ab.byteLength,
          flags,
        })
        titleReq.push({ client_row_id: id, titleblock_text: tbText })
      }

      // --- title-only AI assist (small text payloads) ---
      setProgress("Reading sheet titles…")
      try {
        const res = await fetch("/api/drawings/detect-titles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: titleReq }),
        })
        if (res.ok) {
          const data = await res.json() as { titles?: { client_row_id: string; title: string | null }[] }
          const byId = new Map((data.titles ?? []).map(t => [t.client_row_id, t.title]))
          for (const r of staged) {
            const t = byId.get(r.id)
            if (t) r.title = t
            else r.flags = [...r.flags, "no title"]
          }
        }
      } catch { /* titles are nice-to-have; leave blank + flagged */ }

      setRows(staged)
      setPhase("review")
      setProgress("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not process the drawing set.")
      setPhase("idle")
    }
  }

  // Commit a specific set of rows. Used for the initial commit AND for
  // "Retry failed" (those rows' staged files still exist — staging purges only
  // on success). A row counts as failed if its result is status:"error" OR if
  // no result came back for it at all — so an approved sheet can never silently
  // vanish.
  async function runCommit(toCommit: ProposedRow[]) {
    setError(null)
    setPhase("committing")
    try {
      const res = await fetch("/api/drawings/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          rows: toCommit.map(r => ({
            client_row_id: r.id,
            staging_path: r.stagingPath,
            file_name: `${r.sheetNumber || r.page}.pdf`,
            file_size: r.size,
            file_sha256: r.sha256,
            sheet_number: r.sheetNumber.trim(),
            title: r.title.trim() || null,
            discipline: r.discipline.trim() || null,
            discipline_prefix: r.prefix,
            revision_label: r.revisionLabel.trim() || "Rev 0",
          })),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `Commit failed (HTTP ${res.status})`)
      const results = (data?.results ?? []) as { client_row_id: string; status: string; error?: string }[]
      const okIds = new Set(results.filter(r => r.status === "ok").map(r => r.client_row_id))
      const failed = toCommit
        .filter(r => !okIds.has(r.id))
        .map(r => ({ row: r, error: results.find(x => x.client_row_id === r.id)?.error ?? "no result returned by server" }))
      setCommittedCount(c => c + okIds.size)
      setFailedRows(failed)
      setPhase("done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed.")
      setPhase("review")
    }
  }

  function commit() {
    const included = rows.filter(r => r.include)
    const blank = included.filter(r => !r.sheetNumber.trim())
    if (blank.length > 0) {
      setError(`${blank.length} included sheet${blank.length === 1 ? "" : "s"} ${blank.length === 1 ? "has" : "have"} no sheet number — fill or drop before committing.`)
      return
    }
    setCommittedCount(0)
    void runCommit(included)
  }

  function retryFailed() {
    void runCommit(failedRows.map(f => f.row))
  }

  async function cancel() {
    // Purge staged scratch files if any were uploaded.
    if (batchId && (phase === "review" || phase === "idle")) {
      try {
        await fetch("/api/drawings/discard-staging", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch_id: batchId }),
        })
      } catch { /* best-effort */ }
    }
    onClose()
  }

  const includedCount = rows.filter(r => r.include).length

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget && phase !== "processing" && phase !== "committing") cancel() }}>
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[920px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
        <div className="flex-shrink-0 flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-[15px] font-bold text-[#0F172A]">Import drawing set</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">Split a multi-sheet PDF, review the detected sheets, then commit.</p>
          </div>
          <button onClick={cancel} disabled={phase === "processing" || phase === "committing"}
            className="text-[#64748B] hover:text-[#0F172A] transition-colors disabled:opacity-40">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 min-h-0">
          {error && <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-[12px] text-red-700">{error}</div>}

          {/* IDLE — pick file */}
          {phase === "idle" && (
            <div className="space-y-3">
              <input ref={fileRef} type="file" accept="application/pdf"
                className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#475569] file:text-[11px] file:cursor-pointer" />
              <p className="text-[11px] text-[#94A3B8]">The set is split in your browser — large files never hit the server. Each sheet is detected by its titleblock; you confirm everything before anything is saved.</p>
            </div>
          )}

          {/* PROCESSING */}
          {phase === "processing" && (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[#64748B]">
              <SpinnerIcon className="h-4 w-4" /> {progress || "Working…"}
            </div>
          )}

          {/* REVIEW — editable table */}
          {phase === "review" && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <p className="text-[12px] text-[#475569]"><span className="font-semibold">{rows.length}</span> sheets detected · <span className="font-semibold">{includedCount}</span> to import</p>
                <label className="text-[11px] text-[#64748B] ml-auto flex items-center gap-1.5">
                  Set all discipline:
                  <select onChange={e => { const v = e.target.value; if (v) setRows(prev => prev.map(r => ({ ...r, discipline: v }))) }}
                    className="h-7 px-2 rounded border border-[#E2E8F0] text-[11px] bg-white">
                    <option value="">—</option>
                    {DISCIPLINE_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              </div>
              <table className="w-full text-[12px] border-collapse">
                <thead>
                  <tr className="text-left text-[#64748B] border-b border-[#E2E8F0]">
                    <th className="py-1.5 pr-2 w-10">Pg</th>
                    <th className="py-1.5 pr-2 w-28">Sheet #</th>
                    <th className="py-1.5 pr-2">Title</th>
                    <th className="py-1.5 pr-2 w-36">Discipline</th>
                    <th className="py-1.5 pr-2 w-24">Revision</th>
                    <th className="py-1.5 pr-2 w-14 text-center">Incl.</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const flagged = r.flags.length > 0
                    return (
                      <tr key={r.id} className={`border-b border-[#F1F5F9] ${r.include ? "" : "opacity-40"}`}>
                        <td className="py-1 pr-2 text-[#94A3B8]">{r.page}</td>
                        <td className="py-1 pr-2">
                          <input value={r.sheetNumber}
                            onChange={e => { const v = e.target.value; updateRow(r.id, { sheetNumber: v, prefix: (v.match(/^([A-Za-z]+)/)?.[1] ?? null), discipline: r.discipline || (deriveDiscipline(v.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? null) ?? "") }) }}
                            placeholder="—"
                            className={`w-full h-7 px-2 rounded border text-[12px] font-mono ${!r.sheetNumber ? "border-amber-400 bg-amber-50" : "border-[#E2E8F0]"}`} />
                        </td>
                        <td className="py-1 pr-2">
                          <input value={r.title} onChange={e => updateRow(r.id, { title: e.target.value })}
                            placeholder="(no title — enter manually)"
                            className={`w-full h-7 px-2 rounded border text-[12px] ${!r.title ? "border-amber-300 bg-amber-50/40" : "border-[#E2E8F0]"}`} />
                        </td>
                        <td className="py-1 pr-2">
                          <select value={r.discipline} onChange={e => updateRow(r.id, { discipline: e.target.value })}
                            className="w-full h-7 px-1 rounded border border-[#E2E8F0] text-[12px] bg-white">
                            <option value="">—</option>
                            {DISCIPLINE_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </td>
                        <td className="py-1 pr-2">
                          <input value={r.revisionLabel} onChange={e => updateRow(r.id, { revisionLabel: e.target.value })}
                            className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px]" />
                        </td>
                        <td className="py-1 pr-2 text-center">
                          <input type="checkbox" checked={r.include} onChange={e => updateRow(r.id, { include: e.target.checked })} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {rows.some(r => r.flags.length) && (
                <p className="text-[10px] text-amber-700 mt-2">Amber fields were low-confidence or blank — verify before committing.</p>
              )}
            </div>
          )}

          {/* DONE */}
          {phase === "committing" && (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[#64748B]">
              <SpinnerIcon className="h-4 w-4" /> Committing & verifying sheets…
            </div>
          )}
          {phase === "done" && (
            failedRows.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-[15px] font-bold text-emerald-700">✓ Committed {committedCount} sheet{committedCount === 1 ? "" : "s"}</p>
              </div>
            ) : (
              // LOUD partial failure — leads with a warning, never reads as success.
              <div className="py-6">
                <div className="px-4 py-3 rounded-md bg-amber-50 border border-amber-300 mb-3">
                  <p className="text-[14px] font-bold text-amber-800">
                    {committedCount} committed · {failedRows.length} failed — not everything saved
                  </p>
                  <p className="text-[11px] text-amber-700 mt-0.5">The failed sheets are still staged. Use “Retry failed” to commit them, or close and re-import them.</p>
                </div>
                <ul className="text-[12px] text-[#0F172A] space-y-1 max-h-[40vh] overflow-y-auto">
                  {failedRows.map((f, i) => (
                    <li key={i} className="flex gap-2 px-2 py-1 rounded bg-red-50 border border-red-100">
                      <span className="font-mono text-red-700 flex-shrink-0">p{f.row.page} · {f.row.sheetNumber || "—"}</span>
                      <span className="text-red-600 truncate" title={f.error}>{f.error}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </div>

        <div className="flex-shrink-0 flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
          {phase === "idle" && (
            <>
              <button onClick={cancel} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04]">Cancel</button>
              <button onClick={processSet} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Split & detect</button>
            </>
          )}
          {phase === "review" && (
            <>
              <button onClick={cancel} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04]">Cancel (discard staged)</button>
              <button onClick={commit} disabled={includedCount === 0}
                className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
                Commit {includedCount} sheet{includedCount === 1 ? "" : "s"}
              </button>
            </>
          )}
          {phase === "done" && failedRows.length > 0 && (
            <>
              <button onClick={onClose} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04]">Close anyway</button>
              <button onClick={retryFailed} className="h-8 px-4 rounded-md bg-amber-600 text-white text-[13px] font-semibold hover:bg-amber-700">
                Retry failed ({failedRows.length})
              </button>
            </>
          )}
          {phase === "done" && failedRows.length === 0 && (
            <button onClick={onClose} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Done</button>
          )}
        </div>
      </div>
    </div>
  )
}
