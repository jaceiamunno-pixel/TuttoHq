"use client"

import { useState, useEffect } from "react"
import { uploadFileToSignedUrl } from "@/lib/storage-upload"
import type { SpecBookDoc } from "@/app/dashboard/_shared/types"
import { fmtDate } from "@/app/dashboard/_shared/format"

// Per-project spec book management — lives inside Settings → Projects as an
// inline expandable panel on each project row. Spec book management is
// per-project setup (a real GC project carries 2–4 volumes), not a daily
// workflow, so it was moved out of the dashboard nav into here.
//
// Upload uses the presigned-URL flow (bypasses Vercel's 4.5 MB body limit);
// parsing extracts spec sections + staged submittals, which then appear in the
// dashboard's Submittals → Pending Review.

export default function ProjectSpecBooks({ projectId, projectName, onCountChange }: {
  projectId: string
  projectName: string
  onCountChange?: (n: number) => void
}) {
  const [docs, setDocs]               = useState<SpecBookDoc[]>([])
  const [loading, setLoading]         = useState(true)
  const [showUpload, setShowUpload]   = useState(false)
  const [file, setFile]               = useState<File | null>(null)
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [parsingId, setParsingId]     = useState<string | null>(null)
  const [parseProgress, setParseProgress] = useState(0)

  function load() {
    setLoading(true)
    fetch(`/api/spec-books?project_id=${encodeURIComponent(projectId)}`)
      .then(r => r.json())
      .then(d => {
        const list: SpecBookDoc[] = d.documents ?? []
        setDocs(list)
        onCountChange?.(list.length)
      })
      .catch(() => setDocs([]))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [projectId])

  async function uploadSpecBook(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setSaving(true)
    setError(null)
    setUploadProgress(0)

    // The row is reserved before the file lands; track its id so a failed
    // upload can be rolled back rather than leaving a stuck "pending" doc.
    let documentId: string | null = null
    try {
      // 1. Reserve a project_documents row + a Supabase signed upload URL.
      const presignRes = await fetch("/api/spec-books/presigned-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, file_name: file.name, file_size: file.size }),
      })
      const presign = await presignRes.json()
      if (!presignRes.ok) throw new Error(presign.error ?? "Could not start the upload")
      documentId = presign.document_id as string

      // 2. Send the file straight to storage — bypasses Vercel's 4.5 MB limit.
      await uploadFileToSignedUrl(presign.signed_url, file, p => setUploadProgress(p.percent))

      // 3. Confirm it landed and record the real byte size.
      const finalizeRes = await fetch("/api/spec-books/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId }),
      })
      const finalize = await finalizeRes.json()
      if (!finalizeRes.ok) throw new Error(finalize.error ?? "Could not finalize the upload")

      setShowUpload(false)
      setFile(null)
      setUploadProgress(0)
      load()
      runParse(documentId)
    } catch (err) {
      // Drop the reserved row so the list doesn't show a spec book that's
      // permanently stuck at "pending" with no file behind it.
      if (documentId) fetch(`/api/spec-books/${documentId}`, { method: "DELETE" }).catch(() => {})
      setUploadProgress(0)
      setError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setSaving(false)
    }
  }

  async function runParse(docId: string) {
    setParsingId(docId)
    setParseProgress(0)
    let polling = true
    const poll = async () => {
      while (polling) {
        await new Promise(r => setTimeout(r, 2000))
        if (!polling) break
        try {
          const r = await fetch(`/api/spec-books/${docId}`)
          if (r.ok) {
            const d = await r.json()
            setParseProgress(d.document?.parse_progress ?? 0)
          }
        } catch { /* keep polling */ }
      }
    }
    poll()
    try {
      await fetch(`/api/spec-books/${docId}/parse`, { method: "POST" })
    } catch { /* error surfaced via doc.parse_status */ }
    polling = false
    setParsingId(null)
    load()
  }

  async function deleteDoc(docId: string) {
    if (!confirm("Delete this spec book and all its extracted sections and staged rows?")) return
    await fetch(`/api/spec-books/${docId}`, { method: "DELETE" })
    load()
  }

  return (
    <div className="px-5 py-4 bg-[#F4F5F7]/60 border-t border-[#E2E8F0]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[12px] font-semibold text-[#0F172A]">Spec Books <span className="text-[#64748B] font-normal">({docs.length})</span></p>
          <p className="text-[11px] text-[#64748B] mt-0.5">Volumes uploaded for {projectName}. Extracted submittals appear under Submittals → Pending Review.</p>
        </div>
        <button
          onClick={() => { setFile(null); setError(null); setUploadProgress(0); setShowUpload(true) }}
          className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Upload another volume
        </button>
      </div>

      {loading ? (
        <p className="text-[12px] text-[#64748B] py-3">Loading…</p>
      ) : docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-white px-4 py-6 text-center">
          <p className="text-[12px] text-[#64748B]">No spec books uploaded for this project yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-[#E2E8F0] overflow-clip bg-white">
          <table className="w-full text-[12px] border-collapse">
            <thead className="bg-[#F8F9FA]">
              <tr className="border-b border-[#E2E8F0]">
                <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">File</th>
                <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Pages</th>
                <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-64">Status</th>
                <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-44">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map(doc => {
                const isParsing = parsingId === doc.id || doc.parse_status === "extracting" || doc.parse_status === "classifying"
                const ps = doc.parse_summary
                return (
                  <tr key={doc.id} className="border-b border-[#E2E8F0]/60 last:border-0 hover:bg-[#F8F9FA] transition-colors">
                    <td className="px-3 py-2.5 max-w-0">
                      <p className="text-[#0F172A] font-medium truncate" title={doc.file_name}>{doc.file_name}</p>
                      <p className="text-[11px] text-[#64748B]">{doc.file_size_bytes ? `${(doc.file_size_bytes / 1024 / 1024).toFixed(1)} MB · ` : ""}{fmtDate(doc.uploaded_at)}</p>
                    </td>
                    <td className="px-3 py-2.5 text-[#64748B]">{doc.page_count ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {isParsing ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 rounded-full bg-[#E2E8F0] overflow-hidden">
                            <div className="h-full bg-[#7B9BB5] transition-all" style={{ width: `${parsingId === doc.id ? parseProgress : doc.parse_progress}%` }} />
                          </div>
                          <span className="text-[11px] text-[#64748B]">Parsing…</span>
                        </div>
                      ) : doc.parse_status === "parsed" ? (
                        <>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Parsed</span>
                          {ps && (
                            <p className="text-[11px] text-[#64748B] mt-1">
                              {ps.staged} staged · {ps.sectionsWithSubmittals} of {ps.sectionsScoped} scoped section{ps.sectionsScoped === 1 ? "" : "s"} with submittals
                            </p>
                          )}
                        </>
                      ) : doc.parse_status === "failed" ? (
                        <>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">Failed</span>
                          {doc.parse_error && <p className="text-[11px] text-red-500 mt-1">{doc.parse_error}</p>}
                        </>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#E2E8F0] text-[#64748B]">Not parsed</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
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
                          <button onClick={() => runParse(doc.id)} className="text-[11px] font-semibold text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                            {doc.parse_status === "parsed" ? "Re-parse" : doc.parse_status === "failed" ? "Retry" : "Parse"}
                          </button>
                        )}
                        <button onClick={() => deleteDoc(doc.id)} className="text-[11px] text-red-400/70 hover:text-red-500 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Upload spec book modal ──────────────────────────────────────── */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowUpload(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[480px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Upload Spec Book</h2>
              <button onClick={() => setShowUpload(false)} className="text-[#64748B] hover:text-[#0F172A] transition-colors">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={uploadSpecBook} className="flex flex-col min-h-0">
              <div className="px-6 py-4 space-y-4 overflow-y-auto">
                <p className="text-[12px] text-[#64748B]">
                  Uploading to <span className="font-semibold text-[#0F172A]">{projectName}</span>.
                  The PDF is split into spec sections, SUBMITTALS articles are extracted and classified with AI, then staged for review before anything reaches the submittal log.
                </p>
                <div>
                  <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-[0.08em] mb-1.5">Spec Book PDF <span className="text-red-400">*</span></label>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={e => setFile(e.target.files?.[0] ?? null)}
                    className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]"
                  />
                  {file && (
                    <p className="mt-1.5 text-[11px] text-[#64748B]">{file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</p>
                  )}
                </div>
                {saving && (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-[#E2E8F0] overflow-hidden">
                      <div className="h-full bg-[#7B9BB5] transition-all duration-200" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    <p className="text-[11px] text-[#64748B]">
                      {uploadProgress < 100 ? `Uploading… ${uploadProgress}%` : "Processing spec book…"}
                    </p>
                  </div>
                )}
                {error && (
                  <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{error}</div>
                )}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                <button type="button" onClick={() => setShowUpload(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="submit" disabled={saving || !file}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                  {saving ? "Uploading…" : "Upload & parse"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
