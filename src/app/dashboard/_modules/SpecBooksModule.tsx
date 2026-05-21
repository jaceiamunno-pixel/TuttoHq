"use client"

import { useState, useEffect } from "react"
import { uploadFileToSignedUrl } from "@/lib/storage-upload"
import type { SpecBookDoc, Project } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { labelCls } from "../_shared/ui"

// Spec Books module — extracted verbatim from dashboard/page.tsx (Step 7 of the split).
// State, handlers, action bar, content, and modal are unchanged. Two differences:
//  - the load effect keys on globalProjectId (the module mounts only when active)
//  - runSpecParse's parse-complete handoff to the Submittals "pending review" view
//    is delegated to the onParsed callback, since that state lives in the shell.

export default function SpecBooksModule({ globalProjectId, appProjects, onParsed }: {
  globalProjectId: string
  appProjects: Project[]
  onParsed: () => void
}) {
  // Spec Books (thin document repository)
  const [specDocs, setSpecDocs]                       = useState<SpecBookDoc[]>([])
  const [specDocsLoading, setSpecDocsLoading]         = useState(false)
  const [showSpecUpload, setShowSpecUpload]           = useState(false)
  const [specUploadFile, setSpecUploadFile]           = useState<File | null>(null)
  const [specUploadSaving, setSpecUploadSaving]       = useState(false)
  const [specUploadError, setSpecUploadError]         = useState<string | null>(null)
  const [specUploadProgress, setSpecUploadProgress]   = useState(0)
  const [specParsingId, setSpecParsingId]             = useState<string | null>(null)
  const [specParseProgress, setSpecParseProgress]     = useState(0)

  function loadSpecDocs(pid = globalProjectId) {
    if (!pid) { setSpecDocs([]); return }
    setSpecDocsLoading(true)
    fetch(`/api/spec-books?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setSpecDocs(d.documents ?? []))
      .catch(() => setSpecDocs([]))
      .finally(() => setSpecDocsLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSpecDocs() }, [globalProjectId])

  async function uploadSpecBook(e: React.FormEvent) {
    e.preventDefault()
    if (!specUploadFile || !globalProjectId) return
    setSpecUploadSaving(true)
    setSpecUploadError(null)
    setSpecUploadProgress(0)

    // The row is reserved before the file lands; track its id so a failed
    // upload can be rolled back rather than leaving a stuck "pending" doc.
    let documentId: string | null = null
    try {
      // 1. Reserve a project_documents row + a Supabase signed upload URL.
      const presignRes = await fetch("/api/spec-books/presigned-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: globalProjectId,
          file_name:  specUploadFile.name,
          file_size:  specUploadFile.size,
        }),
      })
      const presign = await presignRes.json()
      if (!presignRes.ok) throw new Error(presign.error ?? "Could not start the upload")
      documentId = presign.document_id as string

      // 2. Send the file straight to storage — bypasses Vercel's 4.5 MB limit.
      await uploadFileToSignedUrl(presign.signed_url, specUploadFile, p =>
        setSpecUploadProgress(p.percent),
      )

      // 3. Confirm it landed and record the real byte size.
      const finalizeRes = await fetch("/api/spec-books/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId }),
      })
      const finalize = await finalizeRes.json()
      if (!finalizeRes.ok) throw new Error(finalize.error ?? "Could not finalize the upload")

      setShowSpecUpload(false)
      setSpecUploadFile(null)
      setSpecUploadProgress(0)
      loadSpecDocs()
      runSpecParse(documentId)
    } catch (err) {
      // Drop the reserved row so the Spec Books list doesn't show a spec book
      // that's permanently stuck at "pending" with no file behind it.
      if (documentId) {
        fetch(`/api/spec-books/${documentId}`, { method: "DELETE" }).catch(() => {})
      }
      setSpecUploadProgress(0)
      setSpecUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setSpecUploadSaving(false)
    }
  }

  async function runSpecParse(docId: string) {
    setSpecParsingId(docId)
    setSpecParseProgress(0)
    let polling = true
    const poll = async () => {
      while (polling) {
        await new Promise(r => setTimeout(r, 2000))
        if (!polling) break
        try {
          const r = await fetch(`/api/spec-books/${docId}`)
          if (r.ok) {
            const d = await r.json()
            setSpecParseProgress(d.document?.parse_progress ?? 0)
          }
        } catch { /* keep polling */ }
      }
    }
    poll()
    let ok = false
    try {
      const res = await fetch(`/api/spec-books/${docId}/parse`, { method: "POST" })
      ok = res.ok
    } catch { /* error surfaced via doc.parse_status */ }
    polling = false
    setSpecParsingId(null)
    loadSpecDocs()
    if (ok) {
      // Parse done — land the user on the staged review in the Submittals module.
      onParsed()
    }
  }

  async function deleteSpecDoc(docId: string) {
    if (!confirm("Delete this spec book and all its extracted sections and staged rows?")) return
    await fetch(`/api/spec-books/${docId}`, { method: "DELETE" })
    loadSpecDocs()
  }

  return (
    <>
      {/* Spec Books action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Spec Books <span className="text-[#64748B] font-normal ml-1">({specDocs.length})</span></p>
        <button
          onClick={() => { setSpecUploadFile(null); setSpecUploadError(null); setSpecUploadProgress(0); setShowSpecUpload(true) }}
          disabled={!globalProjectId}
          title={globalProjectId ? "" : "Select a project first"}
          className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <PlusIcon /> Upload Spec Book
        </button>
      </div>

      {/* ── Spec Books module (thin document repository) ──────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            !globalProjectId ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">Select a project to manage spec books</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Use the Project filter above to choose a project.</p>
              </div>
            ) : specDocsLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : specDocs.length === 0 ? (
              <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No spec books yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Upload a project spec book PDF. Extracted submittals appear in the Submittals module under Pending Review.</p>
                <button onClick={() => { setSpecUploadFile(null); setSpecUploadError(null); setSpecUploadProgress(0); setShowSpecUpload(true) }} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> Upload Spec Book
                </button>
              </div>
            ) : (
              <div className="mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
                <table className="w-full text-[13px] border-collapse">
                  <thead className="bg-[#F8F9FA]">
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">File</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Pages</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-56">Status</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-48">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {specDocs.map(doc => {
                      const isParsing = specParsingId === doc.id || doc.parse_status === "extracting" || doc.parse_status === "classifying"
                      return (
                        <tr key={doc.id} className="border-b border-[#E2E8F0]/60 last:border-0 hover:bg-[#F8F9FA] transition-colors">
                          <td className="px-4 py-2.5 max-w-0">
                            <p className="text-[#0F172A] font-medium truncate" title={doc.file_name}>{doc.file_name}</p>
                            <p className="text-[11px] text-[#64748B]">{doc.file_size_bytes ? `${(doc.file_size_bytes / 1024 / 1024).toFixed(1)} MB · ` : ""}{fmtDateOnly(doc.uploaded_at)}</p>
                          </td>
                          <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{doc.page_count ?? "—"}</td>
                          <td className="px-4 py-2.5">
                            {isParsing ? (
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 w-24 rounded-full bg-[#E2E8F0] overflow-hidden">
                                  <div className="h-full bg-[#7B9BB5] transition-all" style={{ width: `${specParsingId === doc.id ? specParseProgress : doc.parse_progress}%` }} />
                                </div>
                                <span className="text-[11px] text-[#64748B]">Parsing…</span>
                              </div>
                            ) : doc.parse_status === "parsed" ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Parsed</span>
                            ) : doc.parse_status === "failed" ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700" title={doc.parse_error ?? ""}>Failed</span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#E2E8F0] text-[#64748B]">Not parsed</span>
                            )}
                            {doc.parse_status === "failed" && doc.parse_error && (
                              <p className="text-[11px] text-red-500 mt-1">{doc.parse_error}</p>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={async () => {
                                  const r = await fetch(`/api/spec-books/${doc.id}/file`)
                                  const d = await r.json()
                                  if (d.url) window.open(d.url, "_blank")
                                }}
                                className="text-[11px] font-semibold text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                                View PDF
                              </button>
                              {!isParsing && (
                                <button onClick={() => runSpecParse(doc.id)} className="text-[11px] font-semibold text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                                  {doc.parse_status === "parsed" ? "Re-parse" : doc.parse_status === "failed" ? "Retry" : "Parse"}
                                </button>
                              )}
                              <button onClick={() => deleteSpecDoc(doc.id)} className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
      </div>

      {/* ── Upload Spec Book modal ────────────────────────────────────────── */}
      {showSpecUpload && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowSpecUpload(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[480px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Upload Spec Book</h2>
              <button onClick={() => setShowSpecUpload(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={uploadSpecBook} className="flex flex-col min-h-0">
              <div className="px-6 py-4 space-y-4 overflow-y-auto">
                <p className="text-[12px] text-[#64748B]">
                  Uploading to <span className="font-semibold text-[#0F172A]">{appProjects.find(p => p.id === globalProjectId)?.name ?? "this project"}</span>.
                  The PDF is split into spec sections, SUBMITTALS articles are extracted and classified with AI, then staged for your review before anything reaches the submittal log.
                </p>
                <div>
                  <label className={labelCls}>Spec Book PDF <span className="text-red-400">*</span></label>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={e => setSpecUploadFile(e.target.files?.[0] ?? null)}
                    className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]"
                  />
                  {specUploadFile && (
                    <p className="mt-1.5 text-[11px] text-[#64748B]">{specUploadFile.name} ({(specUploadFile.size / 1024 / 1024).toFixed(2)} MB)</p>
                  )}
                </div>
                {specUploadSaving && (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-[#E2E8F0] overflow-hidden">
                      <div
                        className="h-full bg-[#7B9BB5] transition-all duration-200"
                        style={{ width: `${specUploadProgress}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-[#64748B]">
                      {specUploadProgress < 100 ? `Uploading… ${specUploadProgress}%` : "Processing spec book…"}
                    </p>
                  </div>
                )}
                {specUploadError && (
                  <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{specUploadError}</div>
                )}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                <button type="button" onClick={() => setShowSpecUpload(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="submit" disabled={specUploadSaving || !specUploadFile}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {specUploadSaving && <SpinnerIcon className="h-3 w-3" />}
                  {specUploadSaving ? "Uploading…" : "Upload & parse"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
