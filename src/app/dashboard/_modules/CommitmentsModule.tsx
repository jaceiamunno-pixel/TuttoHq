"use client"

import { useState, useEffect } from "react"
import type { Commitment, SubcontractorRow, SupplierRow } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"

// Commitments module — extracted verbatim from dashboard/page.tsx (Step 2 of the split).
// State, handlers, action bar, content, and both modals are unchanged; the only
// difference is the load effect keys on globalProjectId (the module mounts only
// when Commitments is active, so the activeModule guard is no longer needed).

export default function CommitmentsModule({ globalProjectId }: {
  globalProjectId: string
}) {
  // Commitments (executed POs and Subcontracts)
  const [commitments, setCommitments]                 = useState<Commitment[]>([])
  const [commitmentsLoading, setCommitmentsLoading]   = useState(false)
  const [showNewCommitment, setShowNewCommitment]     = useState(false)
  const [viewCommitment, setViewCommitment]           = useState<Commitment | null>(null)
  const [viewCommitmentUrl, setViewCommitmentUrl]     = useState<string | null>(null)
  const [viewCommitmentUrlLoading, setViewCommitmentUrlLoading] = useState(false)
  // New commitment form
  const [cmtType, setCmtType]                         = useState<"subcontract" | "purchase_order">("subcontract")
  const [cmtSubcontractors, setCmtSubcontractors]     = useState<SubcontractorRow[]>([])
  const [cmtSuppliers, setCmtSuppliers]               = useState<SupplierRow[]>([])
  const [cmtPartyId, setCmtPartyId]                   = useState("")          // matched sub/supplier id (empty = will be auto-created on save)
  const [cmtPartyName, setCmtPartyName]               = useState("")          // typed or selected company name (snapshot)
  const [cmtExecutedAt, setCmtExecutedAt]             = useState(() => new Date().toISOString().slice(0, 10))
  const [cmtContractValue, setCmtContractValue]       = useState("")
  const [cmtNotes, setCmtNotes]                       = useState("")
  const [cmtFile, setCmtFile]                         = useState<File | null>(null)
  const [cmtSaving, setCmtSaving]                     = useState(false)
  const [cmtError, setCmtError]                       = useState<string | null>(null)

  function loadCommitments(pid = globalProjectId) {
    if (!pid) { setCommitments([]); return }
    setCommitmentsLoading(true)
    fetch(`/api/commitments?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setCommitments(d.commitments ?? []))
      .catch(() => setCommitments([]))
      .finally(() => setCommitmentsLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCommitments() }, [globalProjectId])

  function loadCommitmentPartyOptions(type: "subcontract" | "purchase_order") {
    if (type === "subcontract") {
      fetch("/api/subcontractors")
        .then(r => r.ok ? r.json() : [])
        .then((rows: SubcontractorRow[]) => setCmtSubcontractors(rows ?? []))
        .catch(() => setCmtSubcontractors([]))
    } else {
      fetch("/api/suppliers")
        .then(r => r.ok ? r.json() : [])
        .then((rows: SupplierRow[]) => setCmtSuppliers(rows ?? []))
        .catch(() => setCmtSuppliers([]))
    }
  }

  // Pre-load both lists whenever the new-commitment modal opens
  useEffect(() => {
    if (!showNewCommitment) return
    loadCommitmentPartyOptions("subcontract")
    loadCommitmentPartyOptions("purchase_order")
  }, [showNewCommitment])

  function resetCommitmentForm() {
    setCmtType("subcontract")
    setCmtPartyId(""); setCmtPartyName("")
    setCmtExecutedAt(new Date().toISOString().slice(0, 10))
    setCmtContractValue(""); setCmtNotes(""); setCmtFile(null)
    setCmtError(null); setCmtSaving(false)
  }

  // Creates a subcontractor or supplier row inline and returns its id, or null on failure.
  async function ensureCommitmentPartyId(
    type: "subcontract" | "purchase_order",
    company_name: string,
  ): Promise<string | null> {
    const url = type === "subcontract" ? "/api/subcontractors" : "/api/suppliers"
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company_name }) })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setCmtError(d.error ?? "Failed to add company")
      return null
    }
    const row = await res.json()
    if (type === "subcontract") {
      setCmtSubcontractors(prev => [...prev, row].sort((a, b) => a.company_name.localeCompare(b.company_name)))
    } else {
      setCmtSuppliers(prev => [...prev, row].sort((a, b) => a.company_name.localeCompare(b.company_name)))
    }
    return row.id as string
  }

  async function createCommitment(e: React.FormEvent) {
    e.preventDefault()
    setCmtError(null)
    if (!globalProjectId) { setCmtError("Select a project before creating a commitment."); return }
    const name = cmtPartyName.trim()
    if (!name) { setCmtError("Enter the company name."); return }
    if (!cmtFile) { setCmtError("Attach the executed file."); return }

    setCmtSaving(true)
    try {
      let partyId = cmtPartyId
      if (!partyId) {
        const created = await ensureCommitmentPartyId(cmtType, name)
        if (!created) return
        partyId = created
        setCmtPartyId(created)
      }

      const { path } = await presignAndUpload("submittals", "commitments", cmtFile)
      const fields: Record<string, string> = {
        project_id: globalProjectId,
        type: cmtType,
        to_company_name: name,
        executed_at: cmtExecutedAt,
        contract_value: cmtContractValue,
        notes: cmtNotes,
        file_path: path,
        file_name: cmtFile.name,
      }
      if (cmtType === "subcontract") fields.to_subcontractor_id = partyId
      else                            fields.to_supplier_id = partyId
      const res = await fetch("/api/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setCmtError(d.error ?? "Failed to create commitment")
        return
      }
      setShowNewCommitment(false)
      resetCommitmentForm()
      loadCommitments()
    } finally {
      setCmtSaving(false)
    }
  }

  async function deleteCommitment(id: string) {
    if (!confirm("Delete this commitment? The executed file will be removed too. This cannot be undone.")) return
    const res = await fetch(`/api/commitments/${id}`, { method: "DELETE" })
    if (res.ok) loadCommitments()
  }

  // Lazy-fetch the signed URL for the executed file when a commitment is opened
  useEffect(() => {
    if (!viewCommitment || !viewCommitment.executed_file_path) {
      setViewCommitmentUrl(null); return
    }
    let cancelled = false
    setViewCommitmentUrlLoading(true)
    fetch(`/api/commitments/${viewCommitment.id}/file`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setViewCommitmentUrl(d?.url ?? null) })
      .catch(() => { if (!cancelled) setViewCommitmentUrl(null) })
      .finally(() => { if (!cancelled) setViewCommitmentUrlLoading(false) })
    return () => { cancelled = true }
  }, [viewCommitment])

  return (
    <>
      {/* Commitments action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Commitments <span className="text-[#64748B] font-normal ml-1">({commitments.length})</span></p>
        <button
          onClick={() => { resetCommitmentForm(); setShowNewCommitment(true) }}
          disabled={!globalProjectId}
          title={globalProjectId ? "" : "Select a project first"}
          className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <PlusIcon /> New Commitment
        </button>
      </div>

      {/* ── Commitments content ───────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            !globalProjectId ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">Select a project to view commitments</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Use the Project filter above to choose a project.</p>
              </div>
            ) : commitmentsLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : (
              <div className="flex flex-col min-h-full">
                {/* Total committed cost stat card */}
                {commitments.length > 0 && (() => {
                  const totalSub = commitments.filter(c => c.type === "subcontract").reduce((s, c) => s + (c.contract_value ?? 0), 0)
                  const totalPo  = commitments.filter(c => c.type === "purchase_order").reduce((s, c) => s + (c.contract_value ?? 0), 0)
                  const subCount = commitments.filter(c => c.type === "subcontract").length
                  const poCount  = commitments.filter(c => c.type === "purchase_order").length
                  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
                  return (
                    <div className="flex items-stretch gap-3 px-4 py-3 border-b border-[#E2E8F0] flex-shrink-0">
                      {[
                        { label: "Total Committed", value: fmt(totalSub + totalPo) },
                        { label: `Subcontracts (${subCount})`, value: fmt(totalSub) },
                        { label: `Purchase Orders (${poCount})`, value: fmt(totalPo) },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex-1 rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-3 py-2">
                          <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">{label}</p>
                          <p className="text-[15px] font-bold tabular-nums text-[#0F172A]">{value}</p>
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {commitments.length === 0 ? (
                  <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">No commitments yet</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5">Upload your first executed subcontract or purchase order for this project.</p>
                    <button onClick={() => { resetCommitmentForm(); setShowNewCommitment(true) }} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                      <PlusIcon /> New Commitment
                    </button>
                  </div>
                ) : (
                  <>
                  {/* Desktop table */}
                  <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
                    <table className="w-full text-[13px] border-collapse">
                      <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                        <tr className="border-b border-[#E2E8F0]">
                          <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Type</th>
                          <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">To</th>
                          <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Value</th>
                          <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Executed</th>
                          <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Status</th>
                          <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {commitments.map(c => (
                          <tr key={c.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors">
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.type === "subcontract" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                                {c.type === "subcontract" ? "Subcontract" : "Purchase Order"}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 max-w-0">
                              <p className="text-[#0F172A] font-medium truncate" title={c.to_company_name}>{c.to_company_name}</p>
                            </td>
                            <td className="px-4 py-2.5 text-[#0F172A] text-[12px] tabular-nums font-medium">
                              {c.contract_value != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c.contract_value) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-[#64748B] text-[12px] whitespace-nowrap">{c.executed_at ? fmtDateOnly(c.executed_at) : "—"}</td>
                            <td className="px-4 py-2.5">
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Executed</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1">
                                <button onClick={() => setViewCommitment(c)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">View</button>
                                <button onClick={() => deleteCommitment(c.id)} className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Mobile card list */}
                  <div className="sm:hidden px-3 py-3 space-y-2">
                    {commitments.map(c => (
                      <div key={c.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.type === "subcontract" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                            {c.type === "subcontract" ? "Subcontract" : "PO"}
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Executed</span>
                        </div>
                        <p className="text-[13px] font-medium text-[#0F172A] mb-1">{c.to_company_name}</p>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[12px] font-semibold text-[#0F172A]">{c.contract_value != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c.contract_value) : "—"}</span>
                          <span className="text-[11px] text-[#64748B]">{c.executed_at ? fmtDateOnly(c.executed_at) : ""}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setViewCommitment(c)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">View</button>
                          <button onClick={() => deleteCommitment(c.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  </>
                )}
              </div>
            )
          )}
      </div>

      {/* ── New Commitment modal ──────────────────────────────────────────── */}
      {showNewCommitment && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowNewCommitment(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[560px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">New Commitment</h2>
              <button onClick={() => setShowNewCommitment(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createCommitment} className="flex flex-col min-h-0">
              <div className="px-6 py-4 space-y-4 overflow-y-auto">
                {/* Type toggle */}
                <div>
                  <label className={labelCls}>Type</label>
                  <div className="flex gap-2">
                    {([
                      { v: "subcontract" as const,    label: "Subcontract" },
                      { v: "purchase_order" as const, label: "Purchase Order" },
                    ]).map(opt => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => {
                          if (opt.v === cmtType) return
                          setCmtType(opt.v)
                          setCmtPartyId(""); setCmtPartyName("")
                        }}
                        className={`flex-1 h-9 px-3 rounded-md border text-[13px] font-medium transition-colors ${
                          cmtType === opt.v
                            ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]"
                            : "border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#94A3B8]"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* To party — free-text with autocomplete from existing rows */}
                <div>
                  <label className={labelCls}>
                    To <span className="text-red-400">*</span>
                    <span className="ml-1 text-[#64748B] font-normal normal-case tracking-normal">
                      ({cmtType === "subcontract" ? "subcontractor" : "supplier"})
                    </span>
                  </label>
                  <input
                    type="text"
                    list="commitment-party-options"
                    value={cmtPartyName}
                    onChange={e => {
                      const name = e.target.value
                      setCmtPartyName(name)
                      const list = cmtType === "subcontract" ? cmtSubcontractors : cmtSuppliers
                      const match = list.find(r => r.company_name.toLowerCase() === name.trim().toLowerCase())
                      setCmtPartyId(match?.id ?? "")
                    }}
                    placeholder={`Type or pick a ${cmtType === "subcontract" ? "subcontractor" : "supplier"}`}
                    className={inputCls}
                  />
                  <datalist id="commitment-party-options">
                    {(cmtType === "subcontract" ? cmtSubcontractors : cmtSuppliers).map(r => (
                      <option key={r.id} value={r.company_name} />
                    ))}
                  </datalist>
                  {cmtPartyName.trim() && !cmtPartyId && (
                    <p className="mt-1.5 text-[11px] text-[#64748B]">
                      New {cmtType === "subcontract" ? "subcontractor" : "supplier"} — will be added on save.
                    </p>
                  )}
                </div>

                {/* Executed date + contract value */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Executed Date</label>
                    <input type="date" value={cmtExecutedAt} onChange={e => setCmtExecutedAt(e.target.value)} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Contract Value</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={cmtContractValue}
                      onChange={e => setCmtContractValue(e.target.value)}
                      placeholder="e.g. 125,000"
                      className={inputCls}
                    />
                  </div>
                </div>

                {/* File */}
                <div>
                  <label className={labelCls}>Executed File <span className="text-red-400">*</span></label>
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    onChange={e => setCmtFile(e.target.files?.[0] ?? null)}
                    className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]"
                  />
                  {cmtFile && (
                    <p className="mt-1.5 text-[11px] text-[#64748B]">{cmtFile.name} ({(cmtFile.size / 1024 / 1024).toFixed(2)} MB)</p>
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea
                    value={cmtNotes}
                    onChange={e => setCmtNotes(e.target.value)}
                    rows={3}
                    placeholder="Optional"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]"
                  />
                </div>

                {cmtError && (
                  <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{cmtError}</div>
                )}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                <button type="button" onClick={() => setShowNewCommitment(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="submit" disabled={cmtSaving || !cmtPartyName.trim() || !cmtFile}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {cmtSaving && <SpinnerIcon className="h-3 w-3" />}
                  {cmtSaving ? "Saving…" : "Save commitment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── View Commitment modal ─────────────────────────────────────────── */}
      {viewCommitment && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) { setViewCommitment(null); setViewCommitmentUrl(null) } }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[820px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0 ${viewCommitment.type === "subcontract" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                  {viewCommitment.type === "subcontract" ? "Subcontract" : "Purchase Order"}
                </span>
                <h2 className="text-[15px] font-bold text-[#0F172A] truncate">{viewCommitment.to_company_name}</h2>
              </div>
              <button onClick={() => { setViewCommitment(null); setViewCommitmentUrl(null) }} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Executed Date</p>
                  <p className="text-[13px] text-[#0F172A]">{viewCommitment.executed_at ? fmtDateOnly(viewCommitment.executed_at) : "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Contract Value</p>
                  <p className="text-[13px] text-[#0F172A] tabular-nums font-medium">
                    {viewCommitment.contract_value != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(viewCommitment.contract_value) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Status</p>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Executed</span>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">File</p>
                  {viewCommitment.executed_file_name ? (
                    viewCommitmentUrl ? (
                      <a href={viewCommitmentUrl} target="_blank" rel="noopener noreferrer" className="text-[13px] text-[#7B9BB5] hover:text-[#5A7A94] truncate inline-block max-w-full">{viewCommitment.executed_file_name}</a>
                    ) : (
                      <p className="text-[13px] text-[#64748B]">{viewCommitment.executed_file_name}</p>
                    )
                  ) : (
                    <p className="text-[13px] text-[#64748B]">—</p>
                  )}
                </div>
                {viewCommitment.notes && (
                  <div className="col-span-2">
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Notes</p>
                    <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{viewCommitment.notes}</p>
                  </div>
                )}
              </div>

              {/* Embedded preview */}
              {viewCommitment.executed_file_path && (
                <div className="rounded-md border border-[#E2E8F0] overflow-hidden">
                  {viewCommitmentUrlLoading ? (
                    <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                      <SpinnerIcon className="h-4 w-4" /> Loading file…
                    </div>
                  ) : viewCommitmentUrl ? (
                    /\.(png|jpe?g|gif|webp)$/i.test(viewCommitment.executed_file_name ?? "") ? (
                      <img src={viewCommitmentUrl} alt={viewCommitment.executed_file_name ?? ""} className="w-full max-h-[600px] object-contain bg-[#F8F9FA]" />
                    ) : (
                      <iframe src={viewCommitmentUrl} title="Executed document" className="w-full border-0" style={{ height: 600 }} />
                    )
                  ) : (
                    <p className="text-[13px] text-red-500 px-4 py-3">Could not load file.</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <button
                type="button"
                onClick={() => { if (viewCommitment) deleteCommitment(viewCommitment.id); setViewCommitment(null); setViewCommitmentUrl(null) }}
                className="h-8 px-4 rounded-md border border-red-200 text-[13px] text-red-500 hover:bg-red-50 transition-colors"
              >Delete</button>
              <button type="button" onClick={() => { setViewCommitment(null); setViewCommitmentUrl(null) }}
                className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
