"use client"

import { useState } from "react"
import type { SubmittalRecord, SubmittalPackage } from "@/app/dashboard/_shared/types"
import GenerationFiles, { type GenFile } from "./GenerationFiles"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"

// ─── Transmittal-package create modal ───────────────────────────────────────
// A package = pick submittal log rows → choose who it's going to → choose a
// coversheet mode → generate the approved documents → download. The PM sends
// them from their own email client. NO email field, NO vendor lookup, NO
// dispatch/send action.
//
// Coversheet mode drives the output shape: 'package' → one PDF (cover + all
// docs); 'per_item' → N PDFs (one per submittal), delivered as per-item
// downloads plus a client-side "Download all" zip.
//
// Two steps: a form (recipient / date / mode / item review), then the delivery
// view. Creating the package is the send event — it stamps the chosen date
// column on every packaged submittal.

const inputCls =
  "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[14px] text-[#0F172A] bg-white " +
  "focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#94A3B8]"
const labelCls = "block text-[11px] font-semibold text-[#64748B] uppercase tracking-[0.08em] mb-1.5"

type RecipientType = "cm" | "ae" | "subcontractor"
type CoversheetMode = "per_item" | "package"

const RECIPIENTS: { value: RecipientType; label: string; hint: string }[] = [
  { value: "cm", label: "CM", hint: "Stamps “sent to A/E” date" },
  { value: "ae", label: "A/E", hint: "Stamps “sent to A/E” date" },
  { value: "subcontractor", label: "Subcontractor", hint: "Stamps “sent to sub” date" },
]

function todayISO(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

export default function PackageCreateModal({
  projectId, projectName, submittals, onClose, onDone,
}: {
  projectId: string
  projectName: string
  submittals: SubmittalRecord[]
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<"form" | "preview">("form")
  const [recipientType, setRecipientType] = useState<RecipientType | null>(null)
  const [sendDate, setSendDate] = useState(todayISO())
  const [coversheetMode, setCoversheetMode] = useState<CoversheetMode | null>(null)
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Set once the package + its first generation exist.
  const [pkg, setPkg] = useState<SubmittalPackage | null>(null)
  const [genFiles, setGenFiles] = useState<GenFile[]>([])
  const [genMode, setGenMode] = useState<CoversheetMode>("package")
  const [warnings, setWarnings] = useState<string[]>([])

  function validate(): boolean {
    if (!recipientType) { setError("Choose who this package is being sent to."); return false }
    if (!coversheetMode) { setError("Choose a coversheet mode."); return false }
    if (!sendDate) { setError("Choose a send date."); return false }
    if (submittals.length === 0) { setError("No submittals selected."); return false }
    return true
  }

  /** Create the package. isDraft=false stamps the date + is the send event. */
  async function createPackage(isDraft: boolean) {
    setError(null)
    if (!validate()) return
    if (pkg) return // already created — guard against double-submit
    setBusy(true)
    try {
      const res = await fetch("/api/submittal-packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          recipient_type: recipientType,
          send_date: sendDate,
          coversheet_mode: coversheetMode,
          notes: notes.trim() || null,
          submittal_ids: submittals.map(s => s.id),
          is_draft: isDraft,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Failed to create the package"); return }
      setPkg(d.package ?? null)
      setWarnings(Array.isArray(d.warnings) ? d.warnings : [])
      const gen = d.generation ?? { coversheetMode: coversheetMode, files: [] }
      setGenMode(gen.coversheetMode as CoversheetMode)
      setGenFiles(mapGenFiles(gen.files ?? []))
      if (isDraft) {
        onDone()
      } else {
        setStep("preview")
      }
    } finally { setBusy(false) }
  }

  /** Attach a human label to each returned file (package PDF vs a named item). */
  function mapGenFiles(files: Array<{ submittalId: string | null; fileName: string; url: string | null }>): GenFile[] {
    return files.map(f => {
      const s = f.submittalId ? submittals.find(x => x.id === f.submittalId) : null
      const label = f.submittalId
        ? (s ? (normalizeSubmittalTitle(s.file_name) || s.file_name) : f.fileName)
        : "Full package"
      return { submittalId: f.submittalId, fileName: f.fileName, url: f.url, label }
    })
  }

  const trackingRef = pkg ? `[${pkg.package_number}]` : "[TTQ-…]"
  const recipientLabel = RECIPIENTS.find(r => r.value === recipientType)?.label ?? "—"

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A]">
              {step === "form" ? "New Transmittal Package" : "Package ready"}
            </h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">
              {submittals.length} submittal{submittals.length === 1 ? "" : "s"} · {projectName}
            </p>
          </div>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#0F172A] transition-colors text-[20px] leading-none">×</button>
        </div>

        {/* ── Step 1: form ───────────────────────────────────────────────── */}
        {step === "form" && (
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            {/* Recipient + date */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className={labelCls}>Sending to <span className="text-red-400">*</span></label>
                <div className="flex gap-1.5">
                  {RECIPIENTS.map(r => (
                    <button
                      key={r.value} type="button"
                      onClick={() => setRecipientType(r.value)}
                      className={`flex-1 h-9 px-2 rounded-md border text-[13px] font-semibold transition-colors ${
                        recipientType === r.value
                          ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]"
                          : "border-[#E2E8F0] text-[#64748B] hover:bg-[#0F172A]/[0.04]"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[#94A3B8] mt-1 h-4">
                  {recipientType ? RECIPIENTS.find(r => r.value === recipientType)?.hint : " "}
                </p>
              </div>
              <div className="sm:w-44">
                <label className={labelCls}>Date <span className="text-red-400">*</span></label>
                <input type="date" value={sendDate} onChange={e => setSendDate(e.target.value)} className={inputCls} />
                <p className="text-[11px] text-[#94A3B8] mt-1 h-4">Defaults to today · editable</p>
              </div>
            </div>

            {/* Coversheet mode */}
            <div>
              <label className={labelCls}>Coversheet <span className="text-red-400">*</span></label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  { value: "per_item" as const, title: "Cover sheet per item", desc: "Each submittal gets its own coversheet before its document." },
                  { value: "package" as const, title: "One cover sheet", desc: "A single cover listing every item, then all documents." },
                ]).map(m => (
                  <button
                    key={m.value} type="button"
                    onClick={() => setCoversheetMode(m.value)}
                    className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                      coversheetMode === m.value
                        ? "border-[#7B9BB5] bg-[#7B9BB5]/10"
                        : "border-[#E2E8F0] hover:bg-[#0F172A]/[0.04]"
                    }`}
                  >
                    <p className="text-[13px] font-semibold text-[#0F172A]">{m.title}</p>
                    <p className="text-[11px] text-[#64748B] mt-0.5">{m.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>Notes</label>
              <textarea
                value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Internal — not printed"
                className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#94A3B8]"
              />
            </div>

            {/* Item review */}
            <div>
              <label className={labelCls}>Items in this package ({submittals.length})</label>
              <div className="rounded-lg border border-[#E2E8F0] overflow-clip max-h-52 overflow-y-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead className="bg-[#F8F9FA] sticky top-0">
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider w-12">#</th>
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider w-20">Spec</th>
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider">Description</th>
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider w-28">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {submittals.map(s => (
                      <tr key={s.id} className="border-b border-[#E2E8F0]/60 last:border-0">
                        <td className="px-3 py-1.5 tabular-nums text-[#64748B]">{s.submittal_seq ?? "—"}</td>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-[#0F172A]">{s.csi_section ?? "—"}</td>
                        <td className="px-3 py-1.5 text-[#0F172A] truncate max-w-[260px]" title={s.file_name}>{s.file_name}</td>
                        <td className="px-3 py-1.5 text-[#64748B]">{s.submittal_type ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{error}</div>}
          </div>
        )}

        {/* ── Step 2: preview + download ─────────────────────────────────── */}
        {step === "preview" && (
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <div className="rounded-lg border border-[#E2E8F0] bg-[#F8F9FA] px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ["Package", trackingRef],
                ["Sent To", recipientLabel],
                ["Date", new Date(`${sendDate}T00:00:00`).toLocaleDateString("en-US")],
                ["Items", String(submittals.length)],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">{label}</p>
                  <p className="text-[13px] text-[#0F172A]">{value}</p>
                </div>
              ))}
            </div>

            {warnings.length > 0 && (
              <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-800 space-y-1">
                <p className="font-semibold">Some items need attention:</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            <div>
              <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider mb-1.5">
                {genMode === "per_item" ? `Documents (${genFiles.length})` : "Package PDF"}
              </p>
              {genFiles.length > 0 ? (
                <GenerationFiles
                  packageNumber={pkg?.package_number ?? "package"}
                  coversheetMode={genMode}
                  files={genFiles}
                  preview
                />
              ) : (
                <p className="text-[13px] text-[#64748B]">No files were produced.</p>
              )}
            </div>
            {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{error}</div>}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
          {step === "form" ? (
            <>
              <button onClick={onClose} disabled={busy}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => createPackage(true)} disabled={busy}
                  className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                  Save as Draft
                </button>
                <button onClick={() => createPackage(false)} disabled={busy}
                  className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                  {busy ? "Working…" : "Create package"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[12px] text-[#64748B]">
                Download {genMode === "per_item" ? "the documents" : "the PDF"} above, then send from your email.
              </p>
              <button onClick={onDone} disabled={busy}
                className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
