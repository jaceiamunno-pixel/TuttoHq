"use client"

import { useState, useEffect, useCallback } from "react"
import type { Project, PurchaseOrder, PoLineItem, Vendor, CommitmentInvoice, PoBalance, SupplierContract } from "../_shared/types"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"
import { VendorPicker } from "../_shared/vendor-picker"

// Purchase Orders module — replaces the old Commitments nav entry. The list is
// scoped to the ACTIVE project (the project in the route); the form still lets
// you pick which project a new PO belongs to. A PO is a commitments row with
// type='purchase_order' plus po_line_items.

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const usd0 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
const numOrNull = (v: string): number | null => {
  const s = v.replace(/[$,\s]/g, "")
  if (s === "") return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

interface EditLine { quantity: string; description: string; unit_price: string }
const emptyLine = (): EditLine => ({ quantity: "", description: "", unit_price: "" })

// PO lifecycle display: draft (neutral) → executed/"Issued" (blue) → accepted
// (green). out_for_signature is a deferred signature-flow state, shown if present.
const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft:             { label: "Draft",             cls: "bg-slate-100 text-slate-600" },
  out_for_signature: { label: "Out for Signature", cls: "bg-amber-100 text-amber-700" },
  executed:          { label: "Issued",            cls: "bg-blue-100 text-blue-700" },
  accepted:          { label: "Accepted",          cls: "bg-green-100 text-green-700" },
}

export default function PurchaseOrdersModule({ appProjects, globalProjectId }: {
  appProjects: Project[]
  globalProjectId: string
}) {
  const [pos, setPos]         = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(false)

  // Form state (shared by new + edit)
  const [showForm, setShowForm]   = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // The PO number is issued server-side at create (the create route calls
  // issue_po_number); it's unknown until the first save, then displayed and
  // editable. poNumberError holds the inline 409 ("already in use").
  const [poNumber, setPoNumber]   = useState("")
  const [poNumberError, setPoNumberError] = useState<string | null>(null)
  const [projectId, setProjectId] = useState("")
  const [vendor, setVendor]       = useState<Vendor | null>(null)
  const [dateRequired, setDateRequired] = useState("")
  const [terms, setTerms]         = useState("")
  const [costCode, setCostCode]   = useState("")
  const [ctTax, setCtTax]         = useState<"" | "included" | "exempt">("")
  const [notes, setNotes]         = useState("")
  const [lines, setLines]         = useState<EditLine[]>([emptyLine()])
  const [status, setStatus]       = useState<PurchaseOrder["status"]>("draft")
  const [acceptedDate, setAcceptedDate] = useState<string | null>(null)  // executed_at when accepted
  // Release-order link (optional). parentContractId = the supplier_contract this
  // PO is released against; null = standalone (the default). releaseContracts =
  // the eligible parents for the current project + vendor (from the view, so the
  // remaining drawdown is live). The server re-validates the link on every save.
  const [parentContractId, setParentContractId] = useState<string | null>(null)
  const [releaseContracts, setReleaseContracts] = useState<SupplierContract[]>([])
  const [saving, setSaving]       = useState(false)
  const [pdfBusy, setPdfBusy]     = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Invoice drawdown (Phase 2) — only meaningful once a PO is saved.
  const [balance, setBalance]   = useState<PoBalance | null>(null)
  const [invoices, setInvoices] = useState<CommitmentInvoice[]>([])
  const [showInvForm, setShowInvForm] = useState(false)
  const [invEditingId, setInvEditingId] = useState<string | null>(null)
  const [invNo, setInvNo]       = useState("")
  const [invDate, setInvDate]   = useState("")
  const [invAmount, setInvAmount] = useState("")
  const [invStatus, setInvStatus] = useState<"draft" | "submitted" | "paid">("draft")
  const [invSaving, setInvSaving] = useState(false)
  const [invError, setInvError]   = useState<string | null>(null)

  const projectName = useCallback((id: string) => {
    const p = appProjects.find(p => p.id === id)
    return p ? `${p.name}${p.number ? ` — ${p.number}` : ""}` : "—"
  }, [appProjects])

  // Scope the list to the ACTIVE project (the project in the route). The PO route
  // filters server-side by project_id on top of RLS; without the param it returns
  // the whole company, which is why every project page used to show the same POs.
  function loadPOs(pid = globalProjectId) {
    if (!pid) { setPos([]); return }
    setLoading(true)
    fetch(`/api/purchase-orders?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setPos(d.purchase_orders ?? []))
      .catch(() => setPos([]))
      .finally(() => setLoading(false))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadPOs() }, [globalProjectId])

  // Eligible release-against contracts = supplier contracts on the SAME project +
  // SAME vendor, RLS-visible (the API filters by both). Refetched whenever the
  // project or vendor changes; a now-invalid selection is cleared so the picker
  // can never hold a cross-project/cross-vendor link. The server still
  // re-validates on save — this is UX, not the security boundary.
  useEffect(() => {
    if (!showForm || !projectId || !vendor) { setReleaseContracts([]); return }
    let cancelled = false
    const params = new URLSearchParams({ project_id: projectId, vendor_id: vendor.id })
    fetch(`/api/supplier-contracts?${params.toString()}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const list: SupplierContract[] = d.supplier_contracts ?? []
        setReleaseContracts(list)
        setParentContractId(prev => (prev && !list.some(c => c.id === prev) ? null : prev))
      })
      .catch(() => { if (!cancelled) setReleaseContracts([]) })
    return () => { cancelled = true }
  }, [showForm, projectId, vendor])

  const linesTotal = lines.reduce((s, l) => s + (numOrNull(l.quantity) ?? 0) * (numOrNull(l.unit_price) ?? 0), 0)

  function resetInvForm() {
    setShowInvForm(false); setInvEditingId(null)
    setInvNo(""); setInvDate(""); setInvAmount(""); setInvStatus("draft")
    setInvSaving(false); setInvError(null)
  }

  function resetForm() {
    setEditingId(null); setPoNumber(""); setPoNumberError(null)
    setProjectId(""); setVendor(null); setDateRequired(""); setTerms("")
    setCostCode(""); setCtTax(""); setNotes(""); setLines([emptyLine()])
    setStatus("draft"); setAcceptedDate(null)
    setParentContractId(null); setReleaseContracts([])
    setSaving(false); setPdfBusy(false); setFormError(null)
    setBalance(null); setInvoices([]); resetInvForm()
  }

  function openNew() {
    resetForm()
    setProjectId(globalProjectId || "")
    setShowForm(true)
  }

  async function openEdit(po: PurchaseOrder) {
    resetForm()
    setShowForm(true)
    setEditingId(po.id)
    setPoNumber(po.po_number ?? "")
    setProjectId(po.project_id)
    setDateRequired(po.date_required ?? "")
    setTerms(po.terms ?? "")
    setCostCode(po.cost_code ?? "")
    setCtTax(po.ct_tax_treatment ?? "")
    setNotes(po.notes ?? "")
    setStatus(po.status)
    setAcceptedDate(po.status === "accepted" ? (po.executed_at ?? null) : null)
    setParentContractId(po.parent_commitment_id ?? null)
    // Load line items + the linked vendor in parallel.
    try {
      const [poRes, vRes] = await Promise.all([
        fetch(`/api/purchase-orders/${po.id}`).then(r => r.json()),
        po.vendor_id ? fetch(`/api/vendors?q=`).then(r => r.json()) : Promise.resolve({ vendors: [] }),
      ])
      const li: PoLineItem[] = poRes.line_items ?? []
      setLines(li.length
        ? li.map(l => ({ quantity: l.quantity != null ? String(l.quantity) : "", description: l.description ?? "", unit_price: l.unit_price != null ? String(l.unit_price) : "" }))
        : [emptyLine()])
      setBalance(poRes.balance ?? null)
      setInvoices(poRes.invoices ?? [])
      // Best-effort vendor hydrate (so the address preview shows on edit).
      if (po.vendor_id) {
        const match = (vRes.vendors as Vendor[] | undefined)?.find(v => v.id === po.vendor_id)
        setVendor(match ?? { id: po.vendor_id, vendor_no: null, company_name: po.to_company_name, street_address: null, city: null, state: null, zip_code: null, phone: null })
      }
    } catch { /* leave defaults */ }
  }

  // Re-read the balance + invoices from the server (commitment_balances is the
  // source of truth) after any invoice change. Deliberately does NOT touch the
  // form fields or line items so unsaved edits aren't clobbered.
  async function refreshDetail(id: string) {
    try {
      const d = await fetch(`/api/purchase-orders/${id}`).then(r => r.json())
      setBalance(d.balance ?? null)
      setInvoices(d.invoices ?? [])
    } catch { /* keep current */ }
    loadPOs()  // keep list drawdown columns in sync
  }

  function closeForm() {
    // Nothing to release: no number is issued until the first save (server-side).
    setShowForm(false)
    resetForm()
  }

  function buildPayload() {
    return {
      project_id: projectId,
      vendor_id: vendor?.id ?? "",
      // Only send po_number when editing an existing PO. On create the number is
      // issued server-side (the POST route ignores any client value); sending the
      // empty draft value would otherwise trip the PATCH "cannot be empty" guard.
      ...(editingId ? { po_number: poNumber.trim() } : {}),
      date_required: dateRequired,
      terms,
      cost_code: costCode,
      ct_tax_treatment: ctTax || null,
      notes,
      parent_commitment_id: parentContractId,
      line_items: lines
        .map(l => ({ quantity: numOrNull(l.quantity), description: l.description.trim(), unit_price: numOrNull(l.unit_price) }))
        .filter(l => l.description || l.quantity != null || l.unit_price != null),
    }
  }

  async function save(): Promise<PurchaseOrder | null> {
    setFormError(null); setPoNumberError(null)
    if (!projectId) { setFormError("Select a project."); return null }
    if (!vendor)    { setFormError("Select a vendor."); return null }
    if (editingId && !poNumber.trim()) { setPoNumberError("PO number cannot be empty."); return null }
    setSaving(true)
    try {
      const url = editingId ? `/api/purchase-orders/${editingId}` : "/api/purchase-orders"
      const method = editingId ? "PATCH" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload()) })
      const d = await res.json()
      if (!res.ok) {
        // 409 = duplicate PO number; surface it inline by the field and keep the
        // form open (the number stays in edit state) so the user can fix it.
        if (res.status === 409) setPoNumberError(d.error ?? "PO number already in use.")
        else setFormError(d.error ?? "Save failed.")
        return null
      }
      const row: PurchaseOrder = d.purchase_order
      // On first save the server issued the number and persisted the draft —
      // adopt its id (so edits PATCH it) and display the issued number.
      if (!editingId) { setEditingId(row.id); setPoNumber(row.po_number ?? ""); setStatus(row.status) }
      loadPOs()
      return row
    } finally {
      setSaving(false)
    }
  }

  async function saveAndClose() {
    const row = await save()
    if (row) { setShowForm(false); resetForm() }
  }

  async function generatePdf(id: string) {
    setPdfBusy(true)
    try {
      const res = await fetch(`/api/purchase-orders/${id}/pdf`, { method: "POST" })
      const d = await res.json()
      if (res.ok && d.url) window.open(d.url, "_blank", "noopener,noreferrer")
      else setFormError(d.error ?? "Could not generate the PDF.")
    } catch { setFormError("Could not generate the PDF.") }
    finally { setPdfBusy(false) }
  }

  // Save first (so the PDF reflects the current form), then generate.
  async function saveThenPdf() {
    const row = await save()
    if (row) await generatePdf(row.id)
  }

  async function deletePO(id: string) {
    if (!confirm("Delete this purchase order? This cannot be undone.")) return
    const res = await fetch(`/api/purchase-orders/${id}`, { method: "DELETE" })
    if (res.ok) {
      if (editingId === id) { setShowForm(false); resetForm() }
      loadPOs()
    }
  }

  // ── Lifecycle status ────────────────────────────────────────────────────────
  // Forward-only progression: draft → executed ("Issued") → accepted. The server
  // enforces the same rules + the accepted guardrail; we also block early here so
  // the message is immediate.
  async function advanceStatus(next: "executed" | "accepted") {
    if (!editingId) return
    if (next === "accepted" && (!poNumber || status === "draft")) {
      setFormError("Mark the PO as Issued (it needs a number) before accepting it.")
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch(`/api/purchase-orders/${editingId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next }),
      })
      const d = await res.json()
      if (!res.ok) { setFormError(d.error ?? "Could not update the status."); return }
      const row: PurchaseOrder = d.purchase_order
      setStatus(row.status)
      setAcceptedDate(row.status === "accepted" ? (row.executed_at ?? null) : null)
      loadPOs()
    } finally { setSaving(false) }
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  function openAddInvoice() {
    resetInvForm()
    setInvDate(new Date().toISOString().slice(0, 10))
    setShowInvForm(true)
  }
  function openEditInvoice(inv: CommitmentInvoice) {
    setInvEditingId(inv.id)
    setInvNo(inv.invoice_no ?? "")
    setInvDate(inv.invoice_date ?? "")
    setInvAmount(inv.amount != null ? String(inv.amount) : "")
    setInvStatus(inv.status)
    setInvError(null)
    setShowInvForm(true)
  }
  async function saveInvoice() {
    if (!editingId) return
    setInvError(null)
    if (numOrNull(invAmount) == null || (numOrNull(invAmount) ?? 0) < 0) { setInvError("Enter a non-negative amount."); return }
    setInvSaving(true)
    try {
      const payload = { invoice_no: invNo, invoice_date: invDate, amount: invAmount, status: invStatus }
      const url = invEditingId
        ? `/api/purchase-orders/${editingId}/invoices/${invEditingId}`
        : `/api/purchase-orders/${editingId}/invoices`
      const res = await fetch(url, { method: invEditingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const d = await res.json()
      if (!res.ok) { setInvError(d.error ?? "Could not save the invoice."); return }
      resetInvForm()
      await refreshDetail(editingId)
    } finally { setInvSaving(false) }
  }
  async function deleteInvoice(invId: string) {
    if (!editingId) return
    if (!confirm("Delete this invoice?")) return
    const res = await fetch(`/api/purchase-orders/${editingId}/invoices/${invId}`, { method: "DELETE" })
    if (res.ok) await refreshDetail(editingId)
  }

  const invStatusBadge = (s: CommitmentInvoice["status"]) => {
    const map: Record<string, string> = {
      draft: "bg-slate-100 text-slate-600",
      submitted: "bg-amber-100 text-amber-700",
      paid: "bg-green-100 text-green-700",
    }
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${map[s] ?? map.draft}`}>{s}</span>
  }

  const statusBadge = (s: PurchaseOrder["status"]) => {
    const m = STATUS_META[s] ?? STATUS_META.draft
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${m.cls}`}>{m.label}</span>
  }

  return (
    <>
      {/* Action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Purchase Orders <span className="text-[#64748B] font-normal ml-1">({pos.length})</span></p>
        <button
          onClick={openNew}
          className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap"
        >
          <PlusIcon /> New PO
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
            <SpinnerIcon className="h-4 w-4" /> Loading…
          </div>
        ) : pos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            </div>
            <p className="text-[15px] font-bold text-[#0F172A]">No purchase orders yet</p>
            <p className="text-[13px] text-[#64748B] mt-1.5">Create your first PO — the number is assigned automatically.</p>
            <button onClick={openNew} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
              <PlusIcon /> New PO
            </button>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">PO #</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Vendor</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Project</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">PO Total</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Billed</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Remaining</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-40">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pos.map(po => (
                    <tr key={po.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors">
                      <td className="px-4 py-2.5 font-semibold text-[#0F172A] tabular-nums">{po.po_number ?? "—"}</td>
                      <td className="px-4 py-2.5 max-w-0"><p className="text-[#0F172A] font-medium truncate" title={po.to_company_name}>{po.to_company_name}</p></td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px] truncate max-w-[200px]" title={projectName(po.project_id)}>{projectName(po.project_id)}</td>
                      <td className="px-4 py-2.5 text-[#0F172A] text-[12px] tabular-nums font-medium">{po.contract_value != null ? usd0(po.contract_value) : "—"}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px] tabular-nums">{usd0(po.billed_to_date ?? 0)}</td>
                      <td className={`px-4 py-2.5 text-[12px] tabular-nums font-medium ${(po.remaining_balance ?? 0) < 0 ? "text-amber-700" : "text-[#0F172A]"}`}>{usd0(po.remaining_balance ?? po.contract_value ?? 0)}</td>
                      <td className="px-4 py-2.5">{statusBadge(po.status)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEdit(po)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Edit</button>
                          <button onClick={() => generatePdf(po.id)} className="text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">PDF</button>
                          <button onClick={() => deletePO(po.id)} className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden px-3 py-3 space-y-2">
              {pos.map(po => (
                <div key={po.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="text-[13px] font-bold text-[#0F172A] tabular-nums">{po.po_number ?? "—"}</span>
                    {statusBadge(po.status)}
                  </div>
                  <p className="text-[13px] font-medium text-[#0F172A]">{po.to_company_name}</p>
                  <p className="text-[11px] text-[#64748B] mb-1.5 truncate">{projectName(po.project_id)}</p>
                  <div className="flex items-center gap-3 mb-2 text-[11px]">
                    <span className="text-[#64748B]">Total <span className="font-semibold text-[#0F172A] tabular-nums">{po.contract_value != null ? usd0(po.contract_value) : "—"}</span></span>
                    <span className="text-[#64748B]">Billed <span className="font-semibold text-[#0F172A] tabular-nums">{usd0(po.billed_to_date ?? 0)}</span></span>
                    <span className="text-[#64748B]">Rem. <span className={`font-semibold tabular-nums ${(po.remaining_balance ?? 0) < 0 ? "text-amber-700" : "text-[#0F172A]"}`}>{usd0(po.remaining_balance ?? po.contract_value ?? 0)}</span></span>
                  </div>
                  <div className="flex items-center justify-end">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(po)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                      <button onClick={() => generatePdf(po.id)} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">PDF</button>
                      <button onClick={() => deletePO(po.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* New / Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) closeForm() }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 flex flex-col max-h-[92vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="flex flex-col min-w-0 gap-1">
                <div className="flex items-center gap-3 min-w-0">
                  <h2 className="text-[15px] font-bold text-[#0F172A]">{editingId ? "Edit Purchase Order" : "New Purchase Order"}</h2>
                  {editingId ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-[#64748B]">PO #</span>
                      <input
                        value={poNumber}
                        onChange={e => { setPoNumber(e.target.value); if (poNumberError) setPoNumberError(null) }}
                        placeholder="PO #"
                        aria-label="PO number"
                        className={`w-32 h-7 px-2 rounded border text-[13px] font-semibold text-[#0F172A] tabular-nums focus:outline-none focus:ring-1 ${poNumberError ? "border-red-300 focus:ring-red-300/40" : "border-[#E2E8F0] focus:ring-[#7B9BB5]/40"}`}
                      />
                    </div>
                  ) : (
                    <span className="text-[13px] font-semibold text-[#7B9BB5] tabular-nums">PO # assigned on save</span>
                  )}
                </div>
                {poNumberError && <p className="text-[11px] text-red-600">{poNumberError}</p>}
              </div>
              <button onClick={closeForm} className="text-[#64748B] hover:text-[#0F172A] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>

            <div className="px-6 py-4 space-y-4 overflow-y-auto">
              {/* Lifecycle status + forward action (saved POs only) */}
              {editingId && (
                <div className="flex items-center justify-between rounded-lg border border-[#E2E8F0] bg-[#F8F9FA] px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#64748B]">Status</span>
                    {statusBadge(status)}
                    {status === "accepted" && acceptedDate && (
                      <span className="text-[11px] text-[#64748B]">Accepted {acceptedDate}</span>
                    )}
                  </div>
                  {status === "draft" && (
                    <button type="button" onClick={() => advanceStatus("executed")} disabled={saving}
                      className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
                      Mark as Issued
                    </button>
                  )}
                  {status === "executed" && (
                    <button type="button" onClick={() => advanceStatus("accepted")} disabled={saving}
                      className="h-8 px-3 rounded-md bg-green-600 text-white text-[12px] font-semibold hover:bg-green-700 transition-colors disabled:opacity-50">
                      Mark as Accepted
                    </button>
                  )}
                </div>
              )}

              {/* Project + Vendor */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Project <span className="text-red-400">*</span></label>
                  <select value={projectId} onChange={e => setProjectId(e.target.value)} className={inputCls}>
                    <option value="">Select a project…</option>
                    {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className={labelCls}>Vendor <span className="text-red-400">*</span></label>
                  <VendorPicker vendor={vendor} onChange={setVendor} />
                </div>
              </div>

              {/* Vendor address preview */}
              {vendor && (vendor.street_address || vendor.city) && (
                <p className="-mt-2 text-[11px] text-[#64748B]">
                  {[vendor.street_address, [vendor.city, vendor.state].filter(Boolean).join(", "), vendor.zip_code].filter(Boolean).join(" · ")}
                </p>
              )}

              {/* Release against a supplier contract (optional) — same project +
                  same vendor only. Standalone (no contract) is the default. */}
              {projectId && vendor && (
                <div>
                  <label className={labelCls}>
                    Release Against Contract <span className="text-[#94A3B8] font-normal normal-case tracking-normal">(optional)</span>
                  </label>
                  {releaseContracts.length === 0 ? (
                    <p className="text-[12px] text-[#94A3B8]">No supplier contracts for this vendor on this project — this PO will be standalone.</p>
                  ) : (
                    <>
                      <select value={parentContractId ?? ""} onChange={e => setParentContractId(e.target.value || null)} className={inputCls}>
                        <option value="">Standalone — no contract</option>
                        {releaseContracts.map(c => {
                          const rem = c.contract_remaining ?? c.contract_value ?? 0
                          const label = [c.cost_code, c.contract_value != null ? usd0(c.contract_value) : null].filter(Boolean).join(" · ")
                          return <option key={c.id} value={c.id}>{label ? `${label} — ` : ""}{usd0(rem)} remaining</option>
                        })}
                      </select>
                      {(() => {
                        const sel = releaseContracts.find(c => c.id === parentContractId)
                        if (!sel) return null
                        const rem = sel.contract_remaining ?? sel.contract_value ?? 0
                        const over = linesTotal > rem
                        return (
                          <div className={`mt-1.5 rounded-md border px-3 py-2 text-[12px] ${over ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-[#F4F5F7] border-[#E2E8F0] text-[#64748B]"}`}>
                            Contract remaining <span className="font-semibold tabular-nums">{usd0(rem)}</span>
                            {over && <span> · This PO ({usd0(linesTotal)}) exceeds the remaining balance. Over-release is allowed — just confirming you can see it.</span>}
                          </div>
                        )
                      })()}
                    </>
                  )}
                </div>
              )}

              {/* Date required + terms + cost code */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Date Required</label>
                  <input type="text" value={dateRequired} onChange={e => setDateRequired(e.target.value)} placeholder="e.g. ASAP / 2 weeks ARO" className={inputCls} />
                </div>
                <div className="flex-1">
                  <label className={labelCls}>Terms</label>
                  <input type="text" value={terms} onChange={e => setTerms(e.target.value)} placeholder="e.g. Net 30" className={inputCls} />
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Cost Code</label>
                  <input type="text" value={costCode} onChange={e => setCostCode(e.target.value)} placeholder="e.g. 03 30 00" className={inputCls} />
                </div>
                <div className="flex-1">
                  <label className={labelCls}>CT Sales &amp; Use Tax</label>
                  <div className="flex gap-2">
                    {([["", "—"], ["included", "Included"], ["exempt", "Exempt"]] as const).map(([v, lbl]) => (
                      <button key={v} type="button" onClick={() => setCtTax(v)}
                        className={`flex-1 h-9 px-2 rounded-md border text-[13px] font-medium transition-colors ${ctTax === v ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]" : "border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#94A3B8]"}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Line items */}
              <div>
                <label className={labelCls}>Line Items</label>
                <div className="rounded-lg border border-[#E2E8F0] overflow-hidden">
                  <div className="grid grid-cols-[70px_1fr_110px_110px_32px] gap-2 px-3 py-2 bg-[#F8F9FA] border-b border-[#E2E8F0] text-[10px] font-bold text-[#64748B] uppercase tracking-wide">
                    <span>Qty</span><span>Description</span><span className="text-right">Unit Price</span><span className="text-right">Amount</span><span />
                  </div>
                  {lines.map((l, i) => {
                    const amt = (numOrNull(l.quantity) ?? 0) * (numOrNull(l.unit_price) ?? 0)
                    return (
                      <div key={i} className="grid grid-cols-[70px_1fr_110px_110px_32px] gap-2 px-3 py-2 items-center border-b border-[#E2E8F0]/60">
                        <input value={l.quantity} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} inputMode="decimal" placeholder="0" className="h-8 px-2 rounded border border-[#E2E8F0] text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                        <input value={l.description} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} placeholder="Description" className="h-8 px-2 rounded border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                        <input value={l.unit_price} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, unit_price: e.target.value } : x))} inputMode="decimal" placeholder="0.00" className="h-8 px-2 rounded border border-[#E2E8F0] text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                        <span className="text-[13px] text-right tabular-nums text-[#0F172A]">{usd(amt)}</span>
                        <button type="button" onClick={() => setLines(ls => ls.length > 1 ? ls.filter((_, j) => j !== i) : [emptyLine()])} className="text-[#94A3B8] hover:text-red-400 transition-colors" title="Remove line"><XIcon className="h-3.5 w-3.5" /></button>
                      </div>
                    )
                  })}
                  <div className="flex items-center justify-between px-3 py-2">
                    <button type="button" onClick={() => setLines(ls => [...ls, emptyLine()])} className="text-[12px] text-[#7B9BB5] font-semibold hover:text-[#5A7A94]">+ Add line</button>
                    <span className="text-[13px] font-bold tabular-nums text-[#0F172A]">Total {usd(linesTotal)}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className={labelCls}>Notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional" className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
              </div>

              {/* ── Billed & Invoices (saved POs only) ───────────────────────── */}
              {editingId && (
                <div className="pt-2 border-t border-[#E2E8F0]">
                  {/* Balance band — straight from commitment_balances (source of truth) */}
                  {(() => {
                    const total = balance?.contract_value ?? 0
                    const billed = balance?.billed_to_date ?? 0
                    const remaining = balance?.remaining_balance ?? total
                    const over = remaining < 0
                    return (
                      <div className="flex items-stretch gap-3 mb-4">
                        {[
                          { label: "PO Total", value: usd(total), cls: "text-[#0F172A]" },
                          { label: "Billed to Date", value: usd(billed), cls: "text-[#0F172A]" },
                          { label: over ? "Remaining (over-billed)" : "Remaining", value: usd(remaining), cls: over ? "text-amber-700" : "text-[#0F172A]" },
                        ].map(({ label, value, cls }, i) => (
                          <div key={label} className={`flex-1 rounded-lg border px-3 py-2 ${i === 2 && over ? "bg-amber-50 border-amber-200" : "bg-[#F4F5F7] border-[#E2E8F0]"}`}>
                            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">{label}</p>
                            <p className={`text-[15px] font-bold tabular-nums ${cls}`}>{value}</p>
                          </div>
                        ))}
                      </div>
                    )
                  })()}

                  {/* Invoice list */}
                  <div className="flex items-center justify-between mb-1.5">
                    <label className={labelCls + " !mb-0"}>Invoices <span className="text-[#94A3B8] font-normal normal-case tracking-normal">({invoices.length})</span></label>
                    {!showInvForm && (
                      <button type="button" onClick={openAddInvoice} className="text-[12px] text-[#7B9BB5] font-semibold hover:text-[#5A7A94]">+ Add invoice</button>
                    )}
                  </div>
                  <div className="rounded-lg border border-[#E2E8F0] overflow-hidden">
                    <div className="grid grid-cols-[1fr_110px_110px_90px_56px] gap-2 px-3 py-2 bg-[#F8F9FA] border-b border-[#E2E8F0] text-[10px] font-bold text-[#64748B] uppercase tracking-wide">
                      <span>Invoice #</span><span>Date</span><span className="text-right">Amount</span><span>Status</span><span />
                    </div>
                    {invoices.length === 0 && !showInvForm && (
                      <p className="px-3 py-3 text-[12px] text-[#94A3B8]">No invoices yet.</p>
                    )}
                    {invoices.map(inv => (
                      <div key={inv.id} className="grid grid-cols-[1fr_110px_110px_90px_56px] gap-2 px-3 py-2 items-center border-b border-[#E2E8F0]/60 text-[13px]">
                        <span className="text-[#0F172A] truncate" title={inv.invoice_no ?? ""}>{inv.invoice_no || "—"}</span>
                        <span className="text-[#64748B] text-[12px]">{inv.invoice_date ?? "—"}</span>
                        <span className="text-right tabular-nums text-[#0F172A]">{usd(inv.amount)}</span>
                        <span>{invStatusBadge(inv.status)}</span>
                        <span className="flex items-center gap-1 justify-end">
                          <button type="button" onClick={() => openEditInvoice(inv)} className="text-[11px] text-[#64748B] hover:text-[#0F172A]">Edit</button>
                          <button type="button" onClick={() => deleteInvoice(inv.id)} className="text-[11px] text-red-400/70 hover:text-red-400">Del</button>
                        </span>
                      </div>
                    ))}
                    {/* Add / edit invoice form row */}
                    {showInvForm && (
                      <div className="px-3 py-2.5 bg-[#F8F9FA] space-y-2">
                        <div className="grid grid-cols-[1fr_110px_110px_90px] gap-2">
                          <input value={invNo} onChange={e => setInvNo(e.target.value)} placeholder="Invoice #" className="h-8 px-2 rounded border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <input type="date" value={invDate} onChange={e => setInvDate(e.target.value)} className="h-8 px-2 rounded border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <input value={invAmount} onChange={e => setInvAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="h-8 px-2 rounded border border-[#E2E8F0] text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <select value={invStatus} onChange={e => setInvStatus(e.target.value as typeof invStatus)} className="h-8 px-1.5 rounded border border-[#E2E8F0] text-[13px] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                            <option value="draft">Draft</option>
                            <option value="submitted">Submitted</option>
                            <option value="paid">Paid</option>
                          </select>
                        </div>
                        {invError && <p className="text-[11px] text-red-600">{invError}</p>}
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={resetInvForm} className="h-7 px-3 rounded border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04]">Cancel</button>
                          <button type="button" onClick={saveInvoice} disabled={invSaving} className="h-7 px-3 rounded bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50 flex items-center gap-1.5">
                            {invSaving && <SpinnerIcon className="h-3 w-3" />} {invEditingId ? "Save invoice" : "Add invoice"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {formError && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{formError}</div>}
            </div>

            <div className="flex justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <div>
                {editingId && (
                  <button type="button" onClick={() => deletePO(editingId)} className="h-8 px-4 rounded-md border border-red-200 text-[13px] text-red-500 hover:bg-red-50 transition-colors">Delete</button>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={closeForm} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="button" onClick={saveThenPdf} disabled={saving || pdfBusy}
                  className="h-8 px-4 rounded-md border border-[#7B9BB5] text-[13px] text-[#5A7A94] font-semibold hover:bg-[#7B9BB5]/10 transition-colors disabled:opacity-50 flex items-center gap-2">
                  {pdfBusy && <SpinnerIcon className="h-3 w-3" />} Generate PDF
                </button>
                <button type="button" onClick={saveAndClose} disabled={saving || pdfBusy}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {saving && <SpinnerIcon className="h-3 w-3" />} {saving ? "Saving…" : "Save draft"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
