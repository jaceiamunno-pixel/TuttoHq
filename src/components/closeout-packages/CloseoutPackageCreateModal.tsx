"use client"

import { useState, useMemo } from "react"
import type { CloseoutItem, SubcontractorRow, SupplierRow, CloseoutPackage } from "@/app/dashboard/_shared/types"

// ─── Closeout package create + preview + dispatch modal (Session K1) ────────
// Mirrors PackageCreateModal: two steps (form → preview), save-as-draft or
// continue to preview + dispatch. Packages dispatched from here go via Gmail
// and the [TTQ-CO-…] tracking ref routes inbound replies back via match-back.

const inputCls =
  "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[14px] text-[#0F172A] bg-white " +
  "focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#94A3B8]"
const labelCls = "block text-[11px] font-semibold text-[#64748B] uppercase tracking-[0.08em] mb-1.5"

export interface ClsVendorPreset {
  id: string
  type: "subcontractor" | "supplier"
  name: string
  email: string | null
}

const CATEGORY_LABEL: Record<string, string> = {
  documents: "Documents",
  inspections: "Inspections",
  warranties: "Warranties",
  handover: "Handover",
  training: "Training",
  subcontractors: "Subcontractor",
  suppliers: "Supplier",
}

export default function CloseoutPackageCreateModal({
  projectId, projectName, items, vendorPreset, subs, suppliers, onClose, onDone,
}: {
  projectId: string
  projectName: string
  items: CloseoutItem[]
  vendorPreset: ClsVendorPreset | null
  subs: SubcontractorRow[]
  suppliers: SupplierRow[]
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<"form" | "preview">("form")
  const [vendorName, setVendorName] = useState(vendorPreset?.name ?? "")
  const [vendorId, setVendorId] = useState<string | null>(vendorPreset?.id ?? null)
  const [vendorType, setVendorType] = useState<"subcontractor" | "supplier" | null>(vendorPreset?.type ?? null)
  const [email, setEmail] = useState(vendorPreset?.email ?? "")
  const [dueDate, setDueDate] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [pkg, setPkg] = useState<CloseoutPackage | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  const vendorOptions = useMemo(() => {
    const rows = [
      ...subs.map(s => ({ id: s.id, type: "subcontractor" as const, name: s.company_name, email: s.email ?? null })),
      ...suppliers.map(s => ({ id: s.id, type: "supplier" as const, name: s.company_name, email: s.email ?? null })),
    ]
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [subs, suppliers])

  function onVendorNameChange(name: string) {
    setVendorName(name)
    const match = vendorOptions.find(v => v.name.toLowerCase() === name.trim().toLowerCase())
    setVendorId(match?.id ?? null)
    setVendorType(match?.type ?? null)
    if (match?.email && !email) setEmail(match.email)
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  async function ensureDraft(): Promise<CloseoutPackage | null> {
    if (pkg) return pkg
    const res = await fetch("/api/closeout-packages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        vendor_id: vendorId,
        vendor_type: vendorType,
        vendor_name: vendorName.trim(),
        sent_to_email: email.trim(),
        due_date: dueDate || null,
        notes: notes.trim() || null,
        closeout_item_ids: items.map(i => i.id),
      }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d.error ?? "Failed to create package"); return null }
    setPkg(d.package)
    return d.package as CloseoutPackage
  }

  async function handleSaveDraft() {
    setError(null)
    if (!validate()) return
    setBusy(true)
    try {
      const created = await ensureDraft()
      if (created) onDone()
    } finally { setBusy(false) }
  }

  async function handleContinue() {
    setError(null)
    if (!validate()) return
    setBusy(true)
    try {
      const created = await ensureDraft()
      if (!created) return
      const res = await fetch(`/api/closeout-packages/${created.id}/pdf`, { method: "POST" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Failed to generate the package PDF"); return }
      setPdfUrl(d.url ?? null)
      setStep("preview")
    } finally { setBusy(false) }
  }

  async function handleDispatch() {
    if (!pkg) return
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/closeout-packages/${pkg.id}/dispatch`, { method: "POST" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Failed to dispatch the package"); return }
      onDone()
    } finally { setBusy(false) }
  }

  function validate(): boolean {
    if (!vendorName.trim()) { setError("Enter the vendor / recipient name."); return false }
    if (!emailValid) { setError("Enter a valid recipient email address."); return false }
    if (items.length === 0) { setError("No closeout items selected."); return false }
    return true
  }

  const trackingRef = pkg ? `[${pkg.package_number}]` : "[TTQ-CO-…]"
  const emailSubject = `Closeout Package — ${projectName} — ${trackingRef}`
  const emailBody = [
    `Hello ${vendorName.trim() || "[Vendor]"},`,
    "",
    `Attached is the closeout package for ${projectName}. Please review the attached`,
    "document and return the required closeout items per the schedule.",
    "",
    `Items expected: ${items.length}`,
    `Due date: ${dueDate ? new Date(`${dueDate}T00:00:00`).toLocaleDateString("en-US") : "Per closeout schedule"}`,
    "",
    "When responding, please reply to this email with your closeout documents attached",
    "(warranties, O&M manuals, certifications, etc.). Our system will route your",
    "submission back to this package using the tracking reference below.",
    "",
    `Tracking ref: ${trackingRef}`,
  ].join("\n")

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A]">
              {step === "form" ? "New Closeout Package" : "Preview & Dispatch"}
            </h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">
              {items.length} item{items.length === 1 ? "" : "s"} · {projectName}
            </p>
          </div>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#0F172A] transition-colors text-[20px] leading-none">×</button>
        </div>

        {step === "form" && (
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className={labelCls}>Vendor / Recipient <span className="text-red-400">*</span></label>
                <input
                  type="text" list="closeout-package-vendor-options" value={vendorName}
                  onChange={e => onVendorNameChange(e.target.value)}
                  placeholder="Subcontractor or supplier"
                  className={inputCls}
                />
                <datalist id="closeout-package-vendor-options">
                  {vendorOptions.map(v => <option key={`${v.type}-${v.id}`} value={v.name} />)}
                </datalist>
              </div>
              <div className="flex-1">
                <label className={labelCls}>Recipient Email <span className="text-red-400">*</span></label>
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className={`${inputCls} ${email && !emailValid ? "border-red-300" : ""}`}
                />
              </div>
            </div>
            {vendorPreset && !vendorPreset.email && (
              <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {vendorPreset.name} has no email on file — enter one above. Consider adding it to the vendor record.
              </p>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className={labelCls}>Due Date</label>
                <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputCls} />
              </div>
            </div>

            <div>
              <label className={labelCls}>Notes</label>
              <textarea
                value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Internal — not emailed"
                className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#94A3B8]"
              />
            </div>

            <div>
              <label className={labelCls}>Items in this package ({items.length})</label>
              <div className="rounded-lg border border-[#E2E8F0] overflow-clip max-h-52 overflow-y-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead className="bg-[#F8F9FA] sticky top-0">
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider">Item</th>
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider w-32">Category</th>
                      <th className="text-left px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider w-24">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(i => (
                      <tr key={i.id} className="border-b border-[#E2E8F0]/60 last:border-0">
                        <td className="px-3 py-1.5 text-[#0F172A] truncate max-w-[280px]" title={i.title}>{i.title}</td>
                        <td className="px-3 py-1.5 text-[#64748B]">
                          {i.folder_name ? `${CATEGORY_LABEL[i.category] ?? i.category} · ${i.folder_name}` : (CATEGORY_LABEL[i.category] ?? i.category)}
                        </td>
                        <td className="px-3 py-1.5 text-[#64748B]">{i.status === "complete" ? "Complete" : i.status === "in_progress" ? "In Progress" : "Incomplete"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{error}</div>}
          </div>
        )}

        {step === "preview" && (
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <div className="rounded-lg border border-[#E2E8F0] bg-[#F8F9FA] px-4 py-3">
              <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider mb-1">Email to be sent</p>
              <p className="text-[13px] text-[#0F172A]"><span className="text-[#64748B]">To:</span> {email}</p>
              <p className="text-[13px] text-[#0F172A]"><span className="text-[#64748B]">Subject:</span> {emailSubject}</p>
              <pre className="mt-2 text-[12px] text-[#475569] whitespace-pre-wrap font-sans leading-relaxed">{emailBody}</pre>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider mb-1.5">Package PDF</p>
              {pdfUrl ? (
                <iframe src={pdfUrl} title="Package PDF preview" className="w-full rounded-lg border border-[#E2E8F0]" style={{ height: 440 }} />
              ) : (
                <p className="text-[13px] text-[#64748B]">PDF preview unavailable — you can still dispatch.</p>
              )}
            </div>
            {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{error}</div>}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
          {step === "form" ? (
            <>
              <button onClick={onClose} disabled={busy}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <button onClick={handleSaveDraft} disabled={busy}
                  className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                  Save as Draft
                </button>
                <button onClick={handleContinue} disabled={busy}
                  className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                  {busy ? "Working…" : "Continue to Preview"}
                </button>
              </div>
            </>
          ) : (
            <>
              <button onClick={() => { setStep("form"); setError(null) }} disabled={busy}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                Back
              </button>
              <button onClick={handleDispatch} disabled={busy}
                className="h-9 px-5 rounded-md bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50">
                {busy ? "Dispatching…" : "Dispatch Package"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
