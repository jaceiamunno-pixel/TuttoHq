"use client"

import { useState, useEffect } from "react"
import type { ChangeOrder, Project } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon } from "../_shared/icons"
import { presignAndUpload } from "@/lib/storage-upload"
import { computeCoTotals } from "../_shared/co-math"
import { exportChangeOrderLogToExcel } from "../_shared/excel-export"
import PcoBuilder from "./PcoBuilder"

// Change Orders module — extracted verbatim from dashboard/page.tsx (Step 6 of the split).
// State, handlers, action bar, content, and both modals are unchanged; the load
// effect keys on globalProjectId (the module mounts only when Change Orders is
// active, so the activeModule guard is no longer needed).

export default function ChangeOrdersModule({ globalProjectId, appProjects }: {
  globalProjectId: string
  appProjects: Project[]
}) {
  // Change Orders
  const [changeOrders, setChangeOrders]               = useState<ChangeOrder[]>([])
  const [coLoading, setCoLoading]                     = useState(false)
  const [showNewCo, setShowNewCo]                     = useState(false)
  const [viewCo, setViewCo]                           = useState<ChangeOrder | null>(null)
  const [coProjectId, setCoProjectId]                 = useState(globalProjectId)
  const [coDate, setCoDate]                           = useState(() => new Date().toISOString().slice(0, 10))
  const [coProposal, setCoProposal]                   = useState("")
  const [coQualifications, setCoQualifications]       = useState("")
  const [coPricingSum, setCoPricingSum]               = useState("")
  const [coScheduleImpact, setCoScheduleImpact]       = useState("TBD")
  const [coScheduleDays, setCoScheduleDays]           = useState("")
  const [coSubmittedBy, setCoSubmittedBy]             = useState("")
  const [coAssignedTo, setCoAssignedTo]               = useState("")
  const [coStatus, setCoStatus]                       = useState("Not submitted")
  const [coAssignedCoNumber, setCoAssignedCoNumber]   = useState("")
  const [coFile, setCoFile]                           = useState<File | null>(null)
  const [coSaving, setCoSaving]                       = useState(false)
  const [coRespondSaving, setCoRespondSaving]         = useState(false)
  const [coResponseStatus, setCoResponseStatus]       = useState("")
  const [coGeneratingPdf, setCoGeneratingPdf]         = useState(false)
  const [coBaseValue, setCoBaseValue]                 = useState("")
  const [coBaseSaving, setCoBaseSaving]               = useState(false)
  const [coRespAmount, setCoRespAmount]               = useState("")
  const [coRealized, setCoRealized]                   = useState("")
  const [coRespRealized, setCoRespRealized]           = useState("")
  const [coExporting, setCoExporting]                 = useState(false)
  const [showPco, setShowPco]                         = useState(false)
  const [editPcoId, setEditPcoId]                     = useState<string | null>(null)

  function loadChangeOrders(pid = globalProjectId) {
    setCoLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/change-orders${qs}`)
      .then(r => r.json())
      // Sort ascending by PCO # (zero-padded co_number; lexical order = numeric,
      // 001→028) so the log reads oldest-first like a real PCO log; new COs append
      // at the bottom. created_at can diverge from the PCO sequence if back-dated.
      .then(d => setChangeOrders([...(d.changeOrders ?? [])].sort(
        (a: ChangeOrder, b: ChangeOrder) => (a.co_number ?? "").localeCompare(b.co_number ?? ""))))
      .catch(() => setChangeOrders([]))
      .finally(() => setCoLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadChangeOrders() }, [globalProjectId])

  // Pre-select the current global project whenever the New CO modal opens.
  useEffect(() => { if (showNewCo) setCoProjectId(globalProjectId) }, [showNewCo, globalProjectId])

  // Seed the editable Base Contract value from the currently-selected project.
  useEffect(() => {
    const p = appProjects.find(p => p.id === globalProjectId)
    setCoBaseValue(p?.base_contract_value != null ? String(p.base_contract_value) : "")
  }, [globalProjectId, appProjects])

  async function createCo(e: React.FormEvent) {
    e.preventDefault()
    setCoSaving(true)
    try {
      const fields: Record<string, string> = {
        project_id: coProjectId, date: coDate, proposal: coProposal,
        qualifications: coQualifications, pricing_sum: coPricingSum,
        schedule_impact: coScheduleImpact, schedule_impact_days: coScheduleDays,
        submitted_by: coSubmittedBy, assigned_to: coAssignedTo, status: coStatus,
        assigned_co_number: coAssignedCoNumber,
        // Realized only counts once a C.O.# is assigned; otherwise send blank → null.
        realized_amount: coAssignedCoNumber.trim() ? coRealized : "",
      }
      if (coFile) {
        const { path } = await presignAndUpload("submittals", "change-orders", coFile)
        fields.file_path = path
        fields.file_name = coFile.name
      }
      const res = await fetch("/api/change-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      })
      if (res.ok) {
        setShowNewCo(false)
        setCoProjectId(""); setCoProposal(""); setCoQualifications(""); setCoPricingSum("")
        setCoScheduleImpact("TBD"); setCoScheduleDays(""); setCoSubmittedBy(""); setCoAssignedTo("")
        setCoStatus("Not submitted"); setCoAssignedCoNumber(""); setCoRealized(""); setCoFile(null)
        setCoDate(new Date().toISOString().slice(0, 10))
        loadChangeOrders()
      }
    } finally { setCoSaving(false) }
  }

  async function deleteCo(coId: string) {
    if (!confirm("Delete this change order? This cannot be undone.")) return
    await fetch(`/api/change-orders/${coId}`, { method: "DELETE" })
    setViewCo(null)
    loadChangeOrders()
  }

  async function generateCoPdf(coId: string) {
    setCoGeneratingPdf(true)
    try {
      const res  = await fetch(`/api/change-orders/${coId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) {
        window.open(data.url, "_blank")
        loadChangeOrders()
      }
    } finally { setCoGeneratingPdf(false) }
  }

  async function saveCoStatus() {
    if (!viewCo) return
    setCoRespondSaving(true)
    try {
      // pricing_sum on a builder PCO is derived (edited via the PCO builder), so
      // the response modal must not rewrite it — omit it from the PATCH entirely.
      const body: Record<string, string | number | null> = {
        status: coResponseStatus, assigned_to: coAssignedTo, assigned_co_number: coAssignedCoNumber,
        // Realized only counts once a C.O.# is assigned; otherwise null.
        realized_amount: coAssignedCoNumber.trim() && coRespRealized.trim() !== "" ? parseFloat(coRespRealized) : null,
      }
      if (!viewCo.has_pco_detail) {
        body.pricing_sum = coRespAmount.trim() === "" ? null : parseFloat(coRespAmount)
      }
      const res = await fetch(`/api/change-orders/${viewCo.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) { setViewCo(null); loadChangeOrders() }
    } finally { setCoRespondSaving(false) }
  }

  // Persist the project's Base Contract value via the existing company-scoped
  // projects PATCH (RLS gates it to the caller's tenant).
  async function saveBaseContract() {
    if (!globalProjectId) return
    setCoBaseSaving(true)
    try {
      const raw = coBaseValue.trim()
      await fetch(`/api/projects/${globalProjectId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_contract_value: raw === "" ? null : raw }),
      })
    } finally { setCoBaseSaving(false) }
  }

  // Contract math (shared co-math is the single source of truth so the on-screen
  // figures match the exported workbook):
  //   Total Proposed = Σ proposed amount (all COs)
  //   Revised Contract Value = Base + Σ realized_amount (stored; non-Rejected)
  //   Open Changes = Σ proposed amount where realized not entered yet (not Rejected)
  const baseNum = parseFloat(coBaseValue)
  const baseForTotals = Number.isFinite(baseNum) ? baseNum : null
  const coTotals = computeCoTotals(changeOrders, baseForTotals)
  const fmtUsd2 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  // PCO # reads as a plain running count ("001"), not the stored "CO-001".
  const pcoLabel = (n: string) => (n ?? "").replace(/^CO-/i, "")

  async function handleExportCoLog() {
    if (!globalProjectId) return
    const proj = appProjects.find(p => p.id === globalProjectId)
    setCoExporting(true)
    try {
      await exportChangeOrderLogToExcel({
        rows: changeOrders,
        projectName: proj?.name ?? "Project",
        projectNumber: proj?.number ?? null,
        baseContractValue: baseForTotals,
      })
    } finally { setCoExporting(false) }
  }

  return (
    <>
      {/* Change Orders action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Change Orders <span className="text-[#64748B] font-normal ml-1">({changeOrders.length})</span></p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={handleExportCoLog} disabled={coExporting || changeOrders.length === 0}
            title="Download the change-order log as an Excel spreadsheet"
            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60">
            {coExporting ? <SpinnerIcon className="h-3.5 w-3.5" /> : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
              </svg>
            )}
            <span className="hidden sm:inline">{coExporting ? "Exporting…" : "Download log"}</span>
          </button>
          <button onClick={() => setShowNewCo(true)} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap">
            <PlusIcon /> New CO
          </button>
          <button onClick={() => setShowPco(true)} disabled={!globalProjectId}
            title={globalProjectId ? "Build a priced PCO with a cover sheet" : "Select a project first"}
            className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50">
            <PlusIcon /> New PCO
          </button>
        </div>
      </div>

      {(showPco || editPcoId) && (() => {
        const p = appProjects.find(x => x.id === globalProjectId)
        return p ? (
          <PcoBuilder
            project={p}
            pcoId={editPcoId}
            onClose={() => { setShowPco(false); setEditPcoId(null) }}
            onSaved={() => loadChangeOrders()}
          />
        ) : null
      })()}

      {/* Contract value summary — mirrors the Gilbane PCO log */}
      {globalProjectId && (
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white px-4 py-3 flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Base Contract Value</label>
            <div className="flex items-center gap-2">
              <input type="number" step="0.01" value={coBaseValue}
                onChange={e => setCoBaseValue(e.target.value)} placeholder="0.00"
                className="h-9 w-44 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 tabular-nums placeholder:text-[#64748B]" />
              <button onClick={saveBaseContract} disabled={coBaseSaving}
                className="h-9 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                {coBaseSaving && <SpinnerIcon className="h-3 w-3" />}{coBaseSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-2">
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">Total Proposed</p>
            <p className="text-[18px] font-bold tabular-nums text-[#0F172A]">{fmtUsd2(coTotals.totalProposed)}</p>
            <p className="text-[10px] text-[#94A3B8] mt-0.5">Σ all proposed amounts</p>
          </div>
          <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-2">
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">Revised Contract Value</p>
            <p className="text-[18px] font-bold tabular-nums text-green-600">{fmtUsd2(coTotals.revisedContractValue)}</p>
            <p className="text-[10px] text-[#94A3B8] mt-0.5">Base + realized (accepted) amounts</p>
          </div>
          <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-2">
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">Open Changes</p>
            <p className="text-[18px] font-bold tabular-nums text-amber-600">{fmtUsd2(coTotals.openChanges)}</p>
            <p className="text-[10px] text-[#94A3B8] mt-0.5">Proposed, not yet realized</p>
          </div>
        </div>
      )}

      {/* Change Orders */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            coLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : (
              <div className="flex flex-col min-h-full">
                {changeOrders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                      </svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">No change orders yet</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5">Create your first change order to track scope changes.</p>
                    <div className="mt-5 flex items-center gap-2">
                      <button onClick={() => setShowNewCo(true)} className="h-9 px-5 rounded-lg border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors inline-flex items-center gap-2">
                        <PlusIcon /> New CO
                      </button>
                      <button onClick={() => setShowPco(true)} disabled={!globalProjectId} className="h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2 disabled:opacity-50">
                        <PlusIcon /> New PCO
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                  {/* Desktop table */}
                  <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                    <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                      <tr className="border-b border-[#E2E8F0]">
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">PCO #</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">CO #</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Project</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Proposal</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Proposed</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Realized</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Sched.</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Date</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Status</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changeOrders.map(c => {
                        const proj = appProjects.find(p => p.id === c.project_id)
                        const statusColor: Record<string, string> = {
                          "Not submitted": "bg-gray-100 text-gray-500",
                          Pending:         "bg-amber-100 text-amber-700",
                          Approved:        "bg-green-100 text-green-700",
                          Rejected:        "bg-red-100 text-red-700",
                        }
                        const badgeCls = statusColor[c.status] ?? "bg-gray-100 text-gray-500"
                        return (
                          <tr key={c.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors">
                            <td className="px-4 py-2.5 text-[12px] font-mono text-[#7B9BB5] whitespace-nowrap">{pcoLabel(c.co_number)}{c.has_pco_detail && <span className="ml-1.5 px-1 py-0.5 rounded bg-[#7B9BB5]/10 text-[#5A7A94] text-[9px] font-sans font-semibold align-middle">PCO</span>}</td>
                            <td className="px-4 py-2.5 text-[12px] text-[#0F172A]">{c.assigned_co_number || "—"}</td>
                            <td className="px-4 py-2.5 text-[#64748B] text-[12px] truncate">{proj?.name ?? "—"}</td>
                            <td className="px-4 py-2.5 max-w-0"><p className="text-[#0F172A] truncate">{c.proposal ?? "—"}</p></td>
                            <td className="px-4 py-2.5 text-[12px] tabular-nums font-medium">
                              {c.pricing_sum != null ? <span className={c.pricing_sum < 0 ? "text-red-600" : "text-[#0F172A]"}>{fmtUsd2(c.pricing_sum)}</span> : <span className="text-[#0F172A]">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-[12px] tabular-nums font-medium">
                              {c.realized_amount != null ? <span className={c.realized_amount < 0 ? "text-red-600" : "text-[#0F172A]"}>{fmtUsd2(c.realized_amount)}</span> : <span className="text-[#94A3B8]">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-[12px]">
                              <span className={c.schedule_impact === "Yes" ? "text-amber-400" : c.schedule_impact === "No" ? "text-green-400" : "text-[#64748B]"}>{c.schedule_impact ?? "TBD"}</span>
                            </td>
                            <td className="px-4 py-2.5 text-[#64748B] text-[12px] whitespace-nowrap">{c.date ? fmtDateOnly(c.date) : "—"}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${badgeCls}`}>{c.status}</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1">
                                {c.has_pco_detail && (
                                  <button onClick={() => setEditPcoId(c.id)}
                                    className="text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Edit</button>
                                )}
                                <button onClick={() => { setViewCo(c); setCoResponseStatus(c.status); setCoAssignedTo(c.assigned_to ?? ""); setCoAssignedCoNumber(c.assigned_co_number ?? ""); setCoRespAmount(c.pricing_sum != null ? String(c.pricing_sum) : ""); setCoRespRealized(c.realized_amount != null ? String(c.realized_amount) : "") }}
                                  className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">View</button>
                                <button onClick={() => generateCoPdf(c.id)} disabled={coGeneratingPdf}
                                  className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                                <button onClick={() => deleteCo(c.id)}
                                  className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                  {/* Mobile card list */}
                  <div className="sm:hidden px-3 py-3 space-y-2">
                    {changeOrders.map(c => {
                      const proj = appProjects.find(p => p.id === c.project_id)
                      const statusColor: Record<string, string> = { "Not submitted": "bg-gray-100 text-gray-500", Pending: "bg-amber-100 text-amber-700", Approved: "bg-green-100 text-green-700", Rejected: "bg-red-100 text-red-700" }
                      const badgeCls = statusColor[c.status] ?? "bg-gray-100 text-gray-500"
                      return (
                        <div key={c.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <span className="text-[11px] font-mono text-[#7B9BB5]">{pcoLabel(c.co_number)}{c.assigned_co_number ? <span className="text-[#64748B]"> · CO {c.assigned_co_number}</span> : null}</span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${badgeCls}`}>{c.status}</span>
                          </div>
                          <p className="text-[13px] font-medium text-[#0F172A] mb-1 truncate">{c.proposal ?? "—"}</p>
                          {proj && <p className="text-[11px] text-[#64748B] mb-1">{proj.name}</p>}
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-[12px] font-semibold ${c.pricing_sum != null && c.pricing_sum < 0 ? "text-red-600" : "text-[#0F172A]"}`}>{c.pricing_sum != null ? fmtUsd2(c.pricing_sum) : "—"}</span>
                            <span className="text-[11px] text-[#64748B]">{c.date ? fmtDateOnly(c.date) : ""}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            {c.has_pco_detail && (
                              <button onClick={() => setEditPcoId(c.id)} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                            )}
                            <button onClick={() => { setViewCo(c); setCoResponseStatus(c.status); setCoAssignedTo(c.assigned_to ?? ""); setCoAssignedCoNumber(c.assigned_co_number ?? ""); setCoRespAmount(c.pricing_sum != null ? String(c.pricing_sum) : ""); setCoRespRealized(c.realized_amount != null ? String(c.realized_amount) : "") }} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">View</button>
                            <button onClick={() => generateCoPdf(c.id)} disabled={coGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                            <button onClick={() => deleteCo(c.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  </>
                )}
              </div>
            )
          )}
      </div>

      {/* ── New Change Order modal ────────────────────────────────────────── */}
      {showNewCo && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowNewCo(false) }}>
          <div className="bg-white border border-[#E2E8F0] rounded-xl w-full max-w-2xl mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[16px] font-bold text-[#0F172A]">New Change Order</h2>
              <button onClick={() => setShowNewCo(false)} className="text-[#64748B] hover:text-[#0F172A] transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={createCo} className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
              {(() => {
                const labelCls2 = "block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1"
                const inputCls2 = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]"
                const selCls2   = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                const coProj = appProjects.find(p => p.id === coProjectId)
                return (<>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Project</label>
                      <select value={coProjectId} onChange={e => setCoProjectId(e.target.value)} className={selCls2}>
                        <option value="">— Select project —</option>
                        {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` (${p.number})` : ""}</option>)}
                      </select>
                      {coProj && (
                        <p className="text-[11px] text-[#64748B] mt-1">{[coProj.gc_name, coProj.location].filter(Boolean).join(" · ")}</p>
                      )}
                    </div>
                    <div>
                      <label className={labelCls2}>Date</label>
                      <input type="date" value={coDate} onChange={e => setCoDate(e.target.value)} className={inputCls2} />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls2}>Proposal <span className="text-red-400">*</span></label>
                    <textarea required value={coProposal} onChange={e => setCoProposal(e.target.value)} rows={4}
                      placeholder="Describe the scope of work for this change order…"
                      className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                  </div>
                  <div>
                    <label className={labelCls2}>Qualifications / Exclusions</label>
                    <textarea value={coQualifications} onChange={e => setCoQualifications(e.target.value)} rows={3}
                      placeholder="List any qualifications or exclusions…"
                      className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Proposed Amount ($) <span className="text-[#94A3B8] normal-case font-normal tracking-normal">(− = credit)</span></label>
                      <input type="number" step="0.01" value={coPricingSum} onChange={e => setCoPricingSum(e.target.value)}
                        placeholder="0.00" className={inputCls2} />
                    </div>
                    <div>
                      <label className={labelCls2}>Status</label>
                      <select value={coStatus} onChange={e => setCoStatus(e.target.value)} className={selCls2}>
                        {["Not submitted","Pending","Approved","Rejected"].map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>CO # <span className="text-[#94A3B8] normal-case font-normal tracking-normal">(assigned, optional)</span></label>
                      <input type="text" value={coAssignedCoNumber} onChange={e => setCoAssignedCoNumber(e.target.value)}
                        placeholder="Assigned CO number" className={inputCls2} />
                    </div>
                    <div>
                      <label className={labelCls2}>Realized Amount ($) <span className="text-[#94A3B8] normal-case font-normal tracking-normal">(accepted; − = credit)</span></label>
                      <input type="number" step="0.01" value={coAssignedCoNumber.trim() ? coRealized : ""} disabled={!coAssignedCoNumber.trim()}
                        onChange={e => setCoRealized(e.target.value)}
                        placeholder={coAssignedCoNumber.trim() ? "Accepted amount" : "Assign a C.O.# first"}
                        className={`${inputCls2} disabled:bg-[#F1F5F9] disabled:text-[#94A3B8] disabled:cursor-not-allowed`} />
                      <p className="text-[10px] text-[#94A3B8] mt-0.5">{coAssignedCoNumber.trim() ? "Counts toward Revised Contract Value" : "Enter a C.O.# to record the accepted amount"}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Schedule Impact</label>
                      <select value={coScheduleImpact} onChange={e => setCoScheduleImpact(e.target.value)} className={selCls2}>
                        {["TBD","Yes","No"].map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    {coScheduleImpact === "Yes" && (
                      <div>
                        <label className={labelCls2}>Days Impact</label>
                        <input type="number" min="0" value={coScheduleDays} onChange={e => setCoScheduleDays(e.target.value)}
                          placeholder="0" className={inputCls2} />
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Submitted By</label>
                      <input type="text" value={coSubmittedBy} onChange={e => setCoSubmittedBy(e.target.value)}
                        placeholder="Name or company" className={inputCls2} />
                    </div>
                    <div>
                      <label className={labelCls2}>Assigned To</label>
                      <input type="text" value={coAssignedTo} onChange={e => setCoAssignedTo(e.target.value)}
                        placeholder="Reviewer name" className={inputCls2} />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls2}>Attach File</label>
                    <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.png,.jpg,.jpeg"
                      onChange={e => setCoFile(e.target.files?.[0] ?? null)}
                      className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-[#E2E8F0] file:text-[#0F172A] file:text-[12px] file:cursor-pointer hover:file:bg-[#CBD5E1] cursor-pointer" />
                  </div>
                </>)
              })()}
            </form>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <button type="button" onClick={() => setShowNewCo(false)}
                className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
              <button type="submit" form="" onClick={createCo} disabled={coSaving || !coProposal.trim()}
                className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                {coSaving && <SpinnerIcon className="h-3 w-3" />}
                {coSaving ? "Creating…" : "Create CO"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Change Order modal ───────────────────────────────────────── */}
      {viewCo && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setViewCo(null) }}>
          <div className="bg-white border border-[#E2E8F0] rounded-xl w-full max-w-2xl mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-[16px] font-bold text-[#0F172A]">PCO {pcoLabel(viewCo.co_number)}</h2>
                  {(() => {
                    const statusColor: Record<string, string> = {
                      "Not submitted": "bg-gray-100 text-gray-500",
                      Pending:         "bg-amber-100 text-amber-700",
                      Approved:        "bg-green-100 text-green-700",
                      Rejected:        "bg-red-100 text-red-700",
                    }
                    return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${statusColor[viewCo.status] ?? "bg-gray-100 text-gray-500"}`}>{viewCo.status}</span>
                  })()}
                </div>
                <p className="text-[12px] text-[#64748B] mt-0.5">{viewCo.date ? fmtDateOnly(viewCo.date) : "No date"}</p>
              </div>
              <button onClick={() => setViewCo(null)} className="text-[#64748B] hover:text-[#0F172A] transition-colors mt-0.5">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
              {/* Project info */}
              {viewCo.project_id && (() => {
                const proj = appProjects.find(p => p.id === viewCo.project_id)
                if (!proj) return null
                return (
                  <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                    {proj.name    && <div><span className="text-[#64748B]">Project: </span><span className="text-[#0F172A] font-medium">{proj.name}</span></div>}
                    {proj.number  && <div><span className="text-[#64748B]">No.: </span><span className="text-[#0F172A]">{proj.number}</span></div>}
                    {proj.gc_name && <div><span className="text-[#64748B]">GC: </span><span className="text-[#0F172A]">{proj.gc_name}</span></div>}
                    {proj.architect && <div><span className="text-[#64748B]">Architect: </span><span className="text-[#0F172A]">{proj.architect}</span></div>}
                    {proj.location && <div className="col-span-2"><span className="text-[#64748B]">Location: </span><span className="text-[#0F172A]">{proj.location}</span></div>}
                  </div>
                )
              })()}

              {/* Meta grid */}
              <div className="grid grid-cols-3 gap-3 text-[12px]">
                {[
                  { label: "Submitted By", value: viewCo.submitted_by ?? "—" },
                  { label: "Assigned To",  value: viewCo.assigned_to  ?? "—" },
                  { label: "Schedule Impact", value: viewCo.schedule_impact ?? "TBD" },
                  { label: "Days Impact", value: viewCo.schedule_impact_days != null ? String(viewCo.schedule_impact_days) : "—" },
                  { label: "Approved At", value: viewCo.approved_at ? fmtDateOnly(viewCo.approved_at) : "—" },
                  { label: "Created",     value: fmtDateOnly(viewCo.created_at) },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">{label}</p>
                    <p className="text-[#0F172A]">{value}</p>
                  </div>
                ))}
              </div>

              {/* Pricing */}
              <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3">
                <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Total Change Order Amount</p>
                <p className={`text-[22px] font-bold tabular-nums ${viewCo.status === "Approved" ? "text-green-400" : "text-[#0F172A]"}`}>
                  {viewCo.pricing_sum != null
                    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(viewCo.pricing_sum)
                    : "—"}
                </p>
              </div>

              {/* Proposal */}
              {viewCo.proposal && (
                <div>
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Proposal</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap leading-relaxed">{viewCo.proposal}</p>
                </div>
              )}

              {/* Qualifications */}
              {viewCo.qualifications && (
                <div>
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Qualifications / Exclusions</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap leading-relaxed">{viewCo.qualifications}</p>
                </div>
              )}

              {/* Attachment + PDF */}
              {viewCo.file_name && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#64748B]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span className="text-[#64748B]">{viewCo.file_name}</span>
                </div>
              )}
              {viewCo.generated_pdf_path && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                  <button onClick={() => generateCoPdf(viewCo.id)} className="text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">View / Regenerate PDF</button>
                </div>
              )}

              {/* Status update */}
              <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
                <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Update</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">Status</label>
                    <select value={coResponseStatus} onChange={e => setCoResponseStatus(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      {["Not submitted","Pending","Approved","Rejected"].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">Assigned To</label>
                    <input type="text" value={coAssignedTo} onChange={e => setCoAssignedTo(e.target.value)}
                      placeholder="Reviewer name"
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">CO # <span className="text-[#94A3B8] normal-case font-normal tracking-normal">(assigned)</span></label>
                    <input type="text" value={coAssignedCoNumber} onChange={e => setCoAssignedCoNumber(e.target.value)}
                      placeholder="Assigned CO number"
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">Proposed Amount ($) <span className="text-[#94A3B8] normal-case font-normal tracking-normal">{viewCo?.has_pco_detail ? "(from PCO)" : "(− = credit)"}</span></label>
                    <input type="number" step="0.01" value={coRespAmount} onChange={e => setCoRespAmount(e.target.value)}
                      disabled={!!viewCo?.has_pco_detail} placeholder="0.00"
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 tabular-nums placeholder:text-[#64748B] disabled:bg-[#F1F5F9] disabled:text-[#94A3B8] disabled:cursor-not-allowed" />
                    {viewCo?.has_pco_detail && <p className="text-[10px] text-[#94A3B8] mt-0.5">Derived from the PCO — use Edit to change pricing.</p>}
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">Realized Amount ($) <span className="text-[#94A3B8] normal-case font-normal tracking-normal">(accepted; − = credit)</span></label>
                    <input type="number" step="0.01" value={coAssignedCoNumber.trim() ? coRespRealized : ""} disabled={!coAssignedCoNumber.trim()}
                      onChange={e => setCoRespRealized(e.target.value)}
                      placeholder={coAssignedCoNumber.trim() ? "Accepted amount" : "Assign a C.O.# first"}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 tabular-nums placeholder:text-[#64748B] disabled:bg-[#F1F5F9] disabled:text-[#94A3B8] disabled:cursor-not-allowed" />
                    <p className="text-[10px] text-[#94A3B8] mt-0.5">{coAssignedCoNumber.trim() ? "Counts toward Revised Contract Value" : "Enter a C.O.# to record the accepted amount"}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-between px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <div className="flex gap-2">
                <button onClick={() => generateCoPdf(viewCo.id)} disabled={coGeneratingPdf}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {coGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" /> Generating…</> : "Generate PDF"}
                </button>
                <button onClick={() => deleteCo(viewCo.id)}
                  className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setViewCo(null)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Close</button>
                <button onClick={saveCoStatus} disabled={coRespondSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {coRespondSaving && <SpinnerIcon className="h-3 w-3" />}
                  {coRespondSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
