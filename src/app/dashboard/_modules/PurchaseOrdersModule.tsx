"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import type { Project, PurchaseOrder, PoLineItem, Vendor } from "../_shared/types"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"

// Purchase Orders module — replaces the old Commitments nav entry. POs are
// company-wide (cross-project, like Library); the form picks a project. A PO is
// a commitments row with type='purchase_order' plus po_line_items.

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
  // issue_po_number); it's unknown until the first save, then displayed.
  const [poNumber, setPoNumber]   = useState("")
  const [projectId, setProjectId] = useState("")
  const [vendor, setVendor]       = useState<Vendor | null>(null)
  const [dateRequired, setDateRequired] = useState("")
  const [terms, setTerms]         = useState("")
  const [costCode, setCostCode]   = useState("")
  const [ctTax, setCtTax]         = useState<"" | "included" | "exempt">("")
  const [notes, setNotes]         = useState("")
  const [lines, setLines]         = useState<EditLine[]>([emptyLine()])
  const [saving, setSaving]       = useState(false)
  const [pdfBusy, setPdfBusy]     = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const projectName = useCallback((id: string) => {
    const p = appProjects.find(p => p.id === id)
    return p ? `${p.name}${p.number ? ` — ${p.number}` : ""}` : "—"
  }, [appProjects])

  function loadPOs() {
    setLoading(true)
    fetch("/api/purchase-orders")
      .then(r => r.json())
      .then(d => setPos(d.purchase_orders ?? []))
      .catch(() => setPos([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { loadPOs() }, [])

  const linesTotal = lines.reduce((s, l) => s + (numOrNull(l.quantity) ?? 0) * (numOrNull(l.unit_price) ?? 0), 0)

  function resetForm() {
    setEditingId(null); setPoNumber("")
    setProjectId(""); setVendor(null); setDateRequired(""); setTerms("")
    setCostCode(""); setCtTax(""); setNotes(""); setLines([emptyLine()])
    setSaving(false); setPdfBusy(false); setFormError(null)
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
      // Best-effort vendor hydrate (so the address preview shows on edit).
      if (po.vendor_id) {
        const match = (vRes.vendors as Vendor[] | undefined)?.find(v => v.id === po.vendor_id)
        setVendor(match ?? { id: po.vendor_id, vendor_no: null, company_name: po.to_company_name, street_address: null, city: null, state: null, zip_code: null, phone: null })
      }
    } catch { /* leave defaults */ }
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
      date_required: dateRequired,
      terms,
      cost_code: costCode,
      ct_tax_treatment: ctTax || null,
      notes,
      line_items: lines
        .map(l => ({ quantity: numOrNull(l.quantity), description: l.description.trim(), unit_price: numOrNull(l.unit_price) }))
        .filter(l => l.description || l.quantity != null || l.unit_price != null),
    }
  }

  async function save(): Promise<PurchaseOrder | null> {
    setFormError(null)
    if (!projectId) { setFormError("Select a project."); return null }
    if (!vendor)    { setFormError("Select a vendor."); return null }
    setSaving(true)
    try {
      const url = editingId ? `/api/purchase-orders/${editingId}` : "/api/purchase-orders"
      const method = editingId ? "PATCH" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload()) })
      const d = await res.json()
      if (!res.ok) { setFormError(d.error ?? "Save failed."); return null }
      const row: PurchaseOrder = d.purchase_order
      // On first save the server issued the number and persisted the draft —
      // adopt its id (so edits PATCH it) and display the issued number.
      if (!editingId) { setEditingId(row.id); setPoNumber(row.po_number ?? "") }
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

  const statusBadge = (s: PurchaseOrder["status"]) => {
    const map: Record<string, string> = {
      draft: "bg-slate-100 text-slate-600",
      issued: "bg-amber-100 text-amber-700",
      executed: "bg-green-100 text-green-700",
    }
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${map[s] ?? map.draft}`}>{s}</span>
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
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Total</th>
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
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-[#0F172A] tabular-nums">{po.contract_value != null ? usd0(po.contract_value) : "—"}</span>
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
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="text-[15px] font-bold text-[#0F172A]">{editingId ? "Edit Purchase Order" : "New Purchase Order"}</h2>
                <span className="text-[13px] font-semibold text-[#7B9BB5] tabular-nums">{poNumber || (editingId ? "" : "PO # assigned on save")}</span>
              </div>
              <button onClick={closeForm} className="text-[#64748B] hover:text-[#0F172A] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>

            <div className="px-6 py-4 space-y-4 overflow-y-auto">
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

// Searchable single-step vendor picker — mirrors the submittals VendorCell
// interaction (anchored fixed-position dropdown, typeahead search), pointed at
// the unified vendors master. Vendors are flat (no person dimension), so this is
// one step. Results are server-filtered (the master is 1,400+ rows).
function VendorPicker({ vendor, onChange }: { vendor: Vendor | null; onChange: (v: Vendor) => void }) {
  const [open, setOpen]   = useState(false)
  const [q, setQ]         = useState("")
  const [rows, setRows]   = useState<Vendor[]>([])
  const [loading, setLoading] = useState(false)
  const [pos, setPos]     = useState<{ top: number; left: number; width: number } | null>(null)
  const ref    = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  // Debounced server search whenever the dropdown is open and the query changes.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const t = setTimeout(() => {
      fetch(`/api/vendors?q=${encodeURIComponent(q.trim())}`)
        .then(r => r.json())
        .then(d => setRows(d.vendors ?? []))
        .catch(() => setRows([]))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(t)
  }, [q, open])

  function toggle() {
    if (open) { setOpen(false); return }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    setQ("")
    setOpen(true)
  }

  return (
    <div ref={ref}>
      <button ref={btnRef} type="button" onClick={toggle}
        className={`w-full h-9 px-3 rounded-md border text-[14px] text-left truncate bg-white transition-colors hover:border-[#7B9BB5]/60 ${open ? "border-[#7B9BB5]" : "border-[#E2E8F0]"} ${vendor ? "text-[#0F172A]" : "text-[#64748B]"}`}>
        {vendor?.company_name ?? "Select a vendor…"}
      </button>
      {open && pos && (
        <div style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.max(pos.width, 280) }}
          className="z-50 bg-white border border-[#E2E8F0] rounded-lg shadow-xl">
          <div className="p-1.5 border-b border-[#E2E8F0]">
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search vendors…"
              className="w-full h-8 px-2 rounded border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {loading ? (
              <p className="px-3 py-2 text-[12px] text-[#94A3B8] flex items-center gap-2"><SpinnerIcon className="h-3 w-3" /> Searching…</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-[#94A3B8]">No vendors match.</p>
            ) : rows.map(v => (
              <button key={v.id} type="button" onClick={() => { onChange(v); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#F8F9FA] ${v.id === vendor?.id ? "bg-[#7B9BB5]/5" : ""}`}>
                <p className={`text-[13px] truncate ${v.id === vendor?.id ? "text-[#7B9BB5] font-semibold" : "text-[#0F172A]"}`}>{v.company_name}</p>
                <p className="text-[11px] text-[#94A3B8] truncate">{[v.vendor_no, [v.city, v.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || " "}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
