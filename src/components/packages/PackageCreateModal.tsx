"use client"

import { useEffect, useRef, useState } from "react"
import type { SubmittalRecord, SubmittalPackage } from "@/app/dashboard/_shared/types"
import type { SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"
import SubmittalCoversheet from "@/components/submittals/SubmittalCoversheet"
import GenerationFiles, { type GenFile } from "./GenerationFiles"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"
import { formatSectionNumber, padSectionSeq } from "@/lib/section-number"
import { transmittalPackageBaseName } from "@/lib/package-name"
import {
  DEFAULT_TRANSMITTAL_EMAIL_SUBJECT,
  DEFAULT_TRANSMITTAL_EMAIL_BODY,
  buildTransmittalMailto,
  resolveTemplate,
  type TransmittalMergeFields,
} from "@/lib/transmittal-email"

// ─── Transmittal-package create modal ───────────────────────────────────────
// A package = pick submittal log rows → choose who it's going to → choose a
// coversheet mode → PREVIEW & FIX the cover → generate the approved documents →
// download. The PM sends them from their own email client. NO email field, NO
// vendor lookup, NO dispatch/send action.
//
// Coversheet mode drives the output shape: 'package' → one PDF (cover + all
// docs); 'per_item' → N PDFs (one per submittal), delivered as per-item
// downloads plus a client-side "Download all" zip.
//
// THREE steps:
//   form     — recipient / date / mode / item review.
//   cover    — the GATE. The actual cover is rendered and the two descriptive
//              fields (description, spec-section title) are click-to-edit,
//              writing straight back to the submittal row via the shared PATCH
//              route. NOTHING is assembled, uploaded, stored, or date-stamped
//              here. Cancel/close/Back on this step = nothing happened.
//   delivery — the download view, shown only AFTER the user accepts. Creating
//              the package is the send event; it stamps the chosen date column.

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

// ─── Preview response shapes (from POST /api/submittal-packages/preview) ─────
interface ReviewerDisplay {
  company: string
  reviewedBy: string
  date: string
  submittalNo: string
}
interface PerItemPreview {
  submittalId: string
  coversheet: SubmittalCoversheetProps
  reviewer: ReviewerDisplay
}
interface PackageItemPreview {
  submittalId: string
  description: string
}
type PreviewData =
  | { mode: "per_item"; items: PerItemPreview[] }
  | { mode: "package"; pendingNumber: string; coverPdfBase64: string | null; items: PackageItemPreview[] }

function base64ToPdfBlobUrl(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
}

export default function PackageCreateModal({
  projectId, projectName, projectCmName, userName, submittals, onClose, onDone,
}: {
  projectId: string
  projectName: string
  /** The project's saved CM name (projects.cm_name) — prefills "Sent To". */
  projectCmName?: string | null
  /** The sending user's display name — resolves the {user_name} merge field. */
  userName?: string
  submittals: SubmittalRecord[]
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<"form" | "cover" | "delivery">("form")
  const [recipientType, setRecipientType] = useState<RecipientType | null>(null)
  const [sendDate, setSendDate] = useState(todayISO())
  const [coversheetMode, setCoversheetMode] = useState<CoversheetMode | null>(null)
  // "Sent To" printed on the transmittal cover — prefilled from the project's
  // saved CM name, editable per package. Blank → server uses the recipient type.
  const [sentTo, setSentTo] = useState(projectCmName ?? "")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Inline, non-blocking confirmation shown under the Send button after a click —
  // covers the no-mailto-handler case (nothing opens) by pointing at the clipboard.
  const [sendNote, setSendNote] = useState<string | null>(null)

  // ── Cover-preview (gate) state ──
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const coverUrlRef = useRef<string | null>(null)

  // Set once the package + its first generation exist.
  const [pkg, setPkg] = useState<SubmittalPackage | null>(null)
  const [genFiles, setGenFiles] = useState<GenFile[]>([])
  const [genMode, setGenMode] = useState<CoversheetMode>("package")
  const [warnings, setWarnings] = useState<string[]>([])

  // Tenant's transmittal "Send via Email" template. Fetched on mount so the
  // handoff can resolve merge fields + fire the mailto SYNCHRONOUSLY in the click
  // gesture (an await before window.location.href drops the navigation). Falls
  // back to the built-in defaults.
  const [emailSubjectTpl, setEmailSubjectTpl] = useState(DEFAULT_TRANSMITTAL_EMAIL_SUBJECT)
  const [emailBodyTpl, setEmailBodyTpl] = useState(DEFAULT_TRANSMITTAL_EMAIL_BODY)
  useEffect(() => {
    let cancelled = false
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d?.transmittal_email_subject_template) setEmailSubjectTpl(d.transmittal_email_subject_template)
        if (d?.transmittal_email_body_template) setEmailBodyTpl(d.transmittal_email_body_template)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Revoke the package-mode cover blob URL on replacement / unmount.
  useEffect(() => {
    coverUrlRef.current = coverUrl
    return () => { if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current) }
  }, [coverUrl])

  function setCoverBlob(b64: string | null) {
    setCoverUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return b64 ? base64ToPdfBlobUrl(b64) : null
    })
  }

  function validate(): boolean {
    if (!recipientType) { setError("Choose who this package is being sent to."); return false }
    if (!coversheetMode) { setError("Choose a coversheet mode."); return false }
    if (!sendDate) { setError("Choose a send date."); return false }
    if (submittals.length === 0) { setError("No submittals selected."); return false }
    return true
  }

  /** Resolve the preview from the server (no writes). Sets state; never throws —
   *  a failure is surfaced via previewError so a caller (including a post-edit
   *  reload) can await it without unwinding the edit. */
  async function loadPreview() {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await fetch("/api/submittal-packages/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          recipient_type: recipientType,
          send_date: sendDate,
          coversheet_mode: coversheetMode,
          submittal_ids: submittals.map(s => s.id),
          sent_to: sentTo.trim() || null,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setPreviewError(d.error ?? "Could not build the preview."); return }
      const data = d as PreviewData
      setPreview(data)
      if (data.mode === "package") setCoverBlob(data.coverPdfBase64)
      else setCoverBlob(null)
    } catch {
      setPreviewError("Could not build the preview.")
    } finally {
      setPreviewLoading(false)
    }
  }

  /** Form → gate. Validate, then move to the cover step and resolve the preview. */
  async function goToPreview() {
    setError(null)
    if (!validate()) return
    setPageIndex(0)
    setStep("cover")
    await loadPreview()
  }

  /** PATCH one field on a submittal row through the shared, RLS-scoped route.
   *  Throws on failure so the inline field reverts + shows the error. */
  async function patchRow(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/submittals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(d.error ?? "Could not save the change.")
  }

  // Inline savers. On success we reload the preview so the cover re-renders from
  // the UPDATED row (the row is the source of truth) — the cover can't show a
  // value the log doesn't have.
  const saveDescription = (id: string) => async (value: string) => {
    await patchRow(id, { file_name: value })
    await loadPreview()
  }
  const saveSpecTitle = (id: string) => async (value: string) => {
    await patchRow(id, { section_name: value })
    await loadPreview()
  }

  /** Create the package. isDraft=false stamps the date + is the send event.
   *  Only reachable from the cover gate. */
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
          sent_to: sentTo.trim() || null,
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
        setStep("delivery")
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
  const logLink = `/projects/${projectId}/submittals`

  // Recipient email — shown as the "To:" line and used as the mailto To:. Only
  // populated when the packaged rows share exactly one email (else ambiguous).
  const recipientEmails = Array.from(new Set(submittals.map(s => s.send_to_email).filter(Boolean))) as string[]
  const recipientEmail = recipientEmails.length === 1 ? recipientEmails[0] : ""
  // Recipient firm — the "Sent To" name printed on the cover, else a single
  // shared per-row company, else empty. Backs {vendor} + the fallback message.
  const recipientFirms = Array.from(new Set(submittals.map(s => s.send_to_company).filter(Boolean))) as string[]
  const recipientVendor = sentTo.trim() || (recipientFirms.length === 1 ? recipientFirms[0] : "")

  /** Open the sender's mail client with the templated draft, and — additively —
   *  copy the composed message to the clipboard as a fallback. On desktop Chrome
   *  with no default mail app, window.location.href = 'mailto:' silently no-ops
   *  (nothing opens); the clipboard copy + inline note keep the button from
   *  appearing dead. NO Gmail/send — the app never sends. Attachments stay manual.
   *
   *  Ordering is load-bearing: the mailto MUST fire synchronously FIRST (no await
   *  before window.location.href) or the browser drops the navigation (RFQ v1a
   *  user-activation rule). The clipboard write runs AFTER it, fire-and-forget —
   *  it is additive, never a replacement for the mailto. */
  function sendViaEmail() {
    // Unique CSI section codes, first-seen order.
    const sections = Array.from(new Set(submittals.map(s => s.csi_section).filter(Boolean))) as string[]
    const titles = submittals.map(s => normalizeSubmittalTitle(s.file_name) || s.file_name)

    const fields: TransmittalMergeFields = {
      project: projectName,
      package_name: pkg?.package_number ?? "",
      sections: sections.join(", "),
      submittals: titles.join(", "),
      vendor: recipientVendor,
      user_name: userName ?? "",
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    }

    const mailto = buildTransmittalMailto({
      to: recipientEmail, subjectTemplate: emailSubjectTpl, bodyTemplate: emailBodyTpl, fields, submittalTitles: titles,
    })

    // Mail client first — synchronous, in-gesture. Nothing awaited before this.
    window.location.href = mailto

    // Additive fallback (AFTER the mailto, never before): copy the composed
    // subject+body so a user with no mailto handler can paste it into a new email.
    // Full (untruncated) submittals list — the clipboard has no URL-length limit.
    const who = recipientEmail || recipientVendor || "your sub"
    const subject = resolveTemplate(emailSubjectTpl, { ...fields })
    const body = resolveTemplate(emailBodyTpl, { ...fields })
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined
    if (clip?.writeText) {
      clip.writeText(`Subject: ${subject}\n\n${body}`).catch(() => {})
      setSendNote(`Opening your email app… if nothing opens, the message has been copied to your clipboard — paste it into a new email to ${who}.`)
    } else {
      // Clipboard API unavailable (old browser / insecure context) — don't claim a copy.
      setSendNote(`Opening your email app… if nothing opens, copy the message text and email it to ${who}.`)
    }
  }

  const total = preview?.mode === "per_item" ? preview.items.length : 0
  const perItem = preview?.mode === "per_item" && total > 0 ? preview.items[Math.min(pageIndex, total - 1)] : null

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full mx-4 sm:mx-0 flex flex-col max-h-[92vh] ${
        step === "cover" ? "sm:w-[900px]" : "sm:w-[680px]"
      }`}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A]">
              {step === "form" ? "New Transmittal Package"
                : step === "cover" ? "Review the cover"
                : "Package ready"}
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
                  {recipientType ? RECIPIENTS.find(r => r.value === recipientType)?.hint : " "}
                </p>
              </div>
              <div className="sm:w-44">
                <label className={labelCls}>Date <span className="text-red-400">*</span></label>
                <input type="date" value={sendDate} onChange={e => setSendDate(e.target.value)} className={inputCls} />
                <p className="text-[11px] text-[#94A3B8] mt-1 h-4">Defaults to today · editable</p>
              </div>
            </div>

            {/* Sent To — the recipient name printed on the transmittal cover */}
            <div>
              <label className={labelCls}>Sent To</label>
              <input
                type="text"
                value={sentTo}
                onChange={e => setSentTo(e.target.value)}
                placeholder="Recipient name — e.g. Turner Construction"
                className={inputCls}
              />
              <p className="text-[11px] text-[#94A3B8] mt-1">
                Prints on the transmittal cover. Prefilled from the project’s saved CM name; editable per package. Leave blank to use the recipient type.
              </p>
            </div>

            {/* Coversheet mode */}
            <div>
              <label className={labelCls}>Coversheet <span className="text-red-400">*</span></label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  { value: "per_item" as const, title: "Cover sheet per item", desc: "Each submittal gets its own coversheet before its document. One PDF per item." },
                  { value: "package" as const, title: "One merged PDF", desc: "A transmittal cover listing every item, then each document behind its own coversheet." },
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
                        <td className="px-3 py-1.5 tabular-nums text-[#64748B]" title={formatSectionNumber(s.csi_section, s.section_seq)}>{padSectionSeq(s.section_seq)}</td>
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

        {/* ── Step 2: cover preview (the gate) ───────────────────────────── */}
        {step === "cover" && (
          <div className="px-6 py-4 space-y-3 overflow-y-auto bg-[#F8FAFC]">
            <div className="rounded-md bg-[#EFF4F9] border border-[#D6E2ED] px-3 py-2 text-[12px] text-[#334155]">
              Click <span className="font-semibold">Submittal Description</span> or <span className="font-semibold">Spec Section Title</span> to edit — the change writes back to the submittal log, so this cover and every future one stay in sync. Nothing is generated or dated until you accept.
            </div>

            {previewLoading && <p className="text-[13px] text-[#64748B] py-8 text-center">Building the preview…</p>}
            {previewError && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{previewError}</div>
            )}

            {/* per_item — page through one editable coversheet per submittal */}
            {!previewLoading && preview?.mode === "per_item" && perItem && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-semibold text-[#64748B]">
                    Cover {Math.min(pageIndex + 1, total)} of {total}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button" disabled={pageIndex === 0}
                      onClick={() => setPageIndex(i => Math.max(0, i - 1))}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white hover:bg-[#0F172A]/[0.04] disabled:opacity-40"
                    >← Prev</button>
                    <button
                      type="button" disabled={pageIndex >= total - 1}
                      onClick={() => setPageIndex(i => Math.min(total - 1, i + 1))}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white hover:bg-[#0F172A]/[0.04] disabled:opacity-40"
                    >Next →</button>
                  </div>
                </div>

                {/* The ACTUAL coversheet (scaled to fit), fed by server-resolved
                    props. Only the two descriptive fields are editable. */}
                <div className="rounded-lg border border-[#E2E8F0] bg-[#f1f5f9] overflow-auto" style={{ maxHeight: 460 }}>
                  <div style={{ transform: "scale(0.62)", transformOrigin: "top left", width: "161.3%" }}>
                    <SubmittalCoversheet
                      key={perItem.submittalId}
                      {...perItem.coversheet}
                      editSubmittalDescription={saveDescription(perItem.submittalId)}
                      editSpecSectionTitle={saveSpecTitle(perItem.submittalId)}
                    />
                  </div>
                </div>

                {/* Read-only, server-resolved reviewer stamp — shown so the user
                    can verify it, never editable. */}
                <div className="rounded-md border border-[#E2E8F0] bg-white px-3 py-2">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">
                    Reviewer stamp · resolved server-side · not editable
                  </p>
                  <p className="text-[12px] text-[#0F172A]">
                    {[perItem.reviewer.company, perItem.reviewer.reviewedBy, perItem.reviewer.date]
                      .filter(Boolean).join(" · ") || "—"}
                    {perItem.reviewer.submittalNo ? ` · No. ${perItem.reviewer.submittalNo}` : ""}
                  </p>
                </div>

                <ReadOnlyNote logLink={logLink} />
              </>
            )}

            {/* package — the actual summary cover + editable descriptions */}
            {!previewLoading && preview?.mode === "package" && (
              <>
                <p className="text-[12px] text-[#64748B]">
                  Tracking ref <span className="font-mono">[{preview.pendingNumber}]</span> — the final number is assigned when you send.
                </p>
                {coverUrl ? (
                  <object data={coverUrl} type="application/pdf" className="w-full rounded-lg border border-[#E2E8F0] bg-white" style={{ height: 420 }}>
                    <p className="p-4 text-[12px] text-[#64748B]">Preview unavailable in this browser — the summary cover will still generate on accept.</p>
                  </object>
                ) : (
                  <p className="text-[13px] text-[#64748B]">No cover could be rendered for this package.</p>
                )}

                <div>
                  <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider mb-1.5">
                    Item descriptions (click to edit — the only editable field on this cover)
                  </p>
                  <div className="rounded-lg border border-[#E2E8F0] bg-white divide-y divide-[#E2E8F0]/70 overflow-clip">
                    {preview.items.map((it) => (
                      <PackageDescriptionRow
                        key={it.submittalId}
                        value={it.description}
                        onSave={saveDescription(it.submittalId)}
                      />
                    ))}
                  </div>
                </div>

                <ReadOnlyNote logLink={logLink} />
              </>
            )}

            {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{error}</div>}
          </div>
        )}

        {/* ── Step 3: delivery + download ────────────────────────────────── */}
        {step === "delivery" && (
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <div className="rounded-lg border border-[#E2E8F0] bg-[#F8F9FA] px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ["Package", trackingRef],
                ["Sent To", sentTo.trim() || recipientLabel],
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
                  zipBaseName={transmittalPackageBaseName(recipientType, sendDate, pkg?.package_number ?? "package")}
                  coversheetMode={genMode}
                  files={genFiles}
                  preview
                />
              ) : (
                <p className="text-[13px] text-[#64748B]">No files were produced.</p>
              )}
            </div>

            {/* Email handoff — opens the sender's mail client with a templated
                draft. Separate from the download above (combining them races the
                click gesture); attachments are added by the sender. */}
            <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
              <p className="text-[11px] text-[#64748B] mb-1.5">
                {recipientEmail
                  ? <>To: <span className="font-semibold text-[#0F172A]">{recipientEmail}</span></>
                  : "To: (no email on file — add one on the vendor)"}
              </p>
              <button
                onClick={sendViaEmail}
                className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                Send via Email
              </button>
              <p className="text-[11px] text-[#94A3B8] mt-2">
                Opens your email app with a pre-written message — attach the downloaded package files before sending.
              </p>
              {sendNote && (
                <p className="text-[12px] text-[#0F172A] bg-[#EFF4F9] border border-[#D6E2ED] rounded-md px-3 py-2 mt-2" role="status" aria-live="polite">
                  {sendNote}
                </p>
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
              <button onClick={goToPreview} disabled={busy}
                className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                Preview cover →
              </button>
            </>
          ) : step === "cover" ? (
            <>
              <button onClick={() => { setStep("form"); setError(null) }} disabled={busy}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                ← Back
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => createPackage(true)} disabled={busy || previewLoading}
                  className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                  Save as Draft
                </button>
                <button onClick={() => createPackage(false)} disabled={busy || previewLoading}
                  className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                  {busy ? "Working…" : "Accept & send"}
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

/** The read-only-fields explainer + navigation links shown under a cover. */
function ReadOnlyNote({ logLink }: { logLink: string }) {
  return (
    <p className="text-[11px] text-[#94A3B8] leading-relaxed">
      Project location, spec/submittal numbers, revision, dates, and the reviewer stamp are read-only here.
      {" "}
      <a href="/settings" target="_blank" rel="noopener noreferrer" className="text-[#7B9BB5] font-semibold hover:underline">Edit location in Settings → Projects ↗</a>
      {" · "}
      <a href={logLink} target="_blank" rel="noopener noreferrer" className="text-[#7B9BB5] font-semibold hover:underline">Open this submittal in the log ↗</a>
    </p>
  )
}

/** One click-to-edit description row for the package-mode summary cover. Mirrors
 *  the coversheet's inline edit (empty rejected, Enter/blur commits, Escape
 *  cancels) but as a compact list row beside the rendered PDF. */
function PackageDescriptionRow({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  async function commit() {
    if (saving) return
    const next = draft.trim()
    if (next.length === 0) { setErr("A description is required."); ref.current?.focus(); return }
    if (next === value.trim()) { setEditing(false); setErr(null); return }
    setSaving(true); setErr(null)
    try { await onSave(next); setEditing(false) }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not save."); ref.current?.focus() }
    finally { setSaving(false) }
  }

  return (
    <div className="px-3 py-2">
      {editing ? (
        <>
          <input
            ref={ref}
            className="w-full h-8 px-2 rounded border border-[#7B9BB5] text-[13px] text-[#0F172A] bg-[#fffdf5] focus:outline-none disabled:opacity-60"
            value={draft}
            disabled={saving}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); commit() }
              else if (e.key === "Escape") { e.preventDefault(); setDraft(value); setErr(null); setEditing(false) }
            }}
          />
          {err && <p className="text-[11px] font-semibold text-red-600 mt-1" role="alert">{err}</p>}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full text-left text-[13px] text-[#0F172A] hover:text-[#7B9BB5] truncate"
          title="Click to edit — writes back to the submittal log"
        >
          {value || "—"}
        </button>
      )}
    </div>
  )
}
