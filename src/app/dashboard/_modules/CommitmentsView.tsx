"use client"

import { useState, useEffect } from "react"
import type { Project, SupplierContract, Vendor } from "../_shared/types"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"
import { VendorPicker } from "../_shared/vendor-picker"

// Commitments view — supplier contracts and (Part 3) their release-order PO
// drawdown. A supplier contract is a commitments row with type='supplier_contract'
// that POs are released against. All drawdown numbers (contract_value,
// released_to_children, contract_remaining) come straight from the
// commitment_balances view via /api/supplier-contracts — never summed client-side.

const usd0 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
const numOrNull = (v: string): number | null => {
  const s = v.replace(/[$,\s]/g, "")
  if (s === "") return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export default function CommitmentsView({ globalProjectId }: {
  appProjects: Project[]
  globalProjectId: string
}) {
  const [contracts, setContracts] = useState<SupplierContract[]>([])
  const [loading, setLoading]     = useState(false)

  // Create / edit form (shared)
  const [showForm, setShowForm]   = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [vendor, setVendor]       = useState<Vendor | null>(null)
  const [contractValue, setContractValue] = useState("")
  const [costCode, setCostCode]   = useState("")
  const [terms, setTerms]         = useState("")
  const [notes, setNotes]         = useState("")
  const [saving, setSaving]       = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function loadContracts(pid = globalProjectId) {
    if (!pid) { setContracts([]); return }
    setLoading(true)
    fetch(`/api/supplier-contracts?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setContracts(d.supplier_contracts ?? []))
      .catch(() => setContracts([]))
      .finally(() => setLoading(false))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadContracts() }, [globalProjectId])

  function resetForm() {
    setEditingId(null); setVendor(null)
    setContractValue(""); setCostCode(""); setTerms(""); setNotes("")
    setSaving(false); setFormError(null)
  }
  function openNew() { resetForm(); setShowForm(true) }
  function openEdit(c: SupplierContract) {
    resetForm()
    setEditingId(c.id)
    setVendor(c.vendor_id ? { id: c.vendor_id, vendor_no: null, company_name: c.to_company_name, street_address: null, city: null, state: null, zip_code: null, phone: null } : null)
    setContractValue(c.contract_value != null ? String(c.contract_value) : "")
    setCostCode(c.cost_code ?? "")
    setTerms(c.terms ?? "")
    setNotes(c.notes ?? "")
    setShowForm(true)
  }
  function closeForm() { setShowForm(false); resetForm() }

  async function save() {
    setFormError(null)
    if (!globalProjectId) { setFormError("Select a project."); return }
    if (!vendor)          { setFormError("Select a vendor."); return }
    setSaving(true)
    try {
      const payload = {
        project_id: globalProjectId,
        vendor_id: vendor.id,
        contract_value: contractValue,
        cost_code: costCode,
        terms,
        notes,
      }
      const url = editingId ? `/api/supplier-contracts/${editingId}` : "/api/supplier-contracts"
      const res = await fetch(url, { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const d = await res.json()
      if (!res.ok) { setFormError(d.error ?? "Save failed."); return }
      closeForm()
      loadContracts()
    } finally { setSaving(false) }
  }

  async function deleteContract(id: string) {
    if (!confirm("Delete this supplier contract? Any POs released against it become standalone POs (they are not deleted). This cannot be undone.")) return
    const res = await fetch(`/api/supplier-contracts/${id}`, { method: "DELETE" })
    if (res.ok) { if (editingId === id) closeForm(); loadContracts() }
  }

  const previewValue = numOrNull(contractValue)

  return (
    <>
      {/* Action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Commitments <span className="text-[#64748B] font-normal ml-1">({contracts.length})</span></p>
        <button
          onClick={openNew}
          disabled={!globalProjectId}
          title={globalProjectId ? "" : "Select a project first"}
          className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <PlusIcon /> New Supplier Contract
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
            <SpinnerIcon className="h-4 w-4" /> Loading…
          </div>
        ) : contracts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            </div>
            <p className="text-[15px] font-bold text-[#0F172A]">No supplier contracts yet</p>
            <p className="text-[13px] text-[#64748B] mt-1.5">Create a supplier contract, then release purchase orders against it.</p>
            <button onClick={openNew} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
              <PlusIcon /> New Supplier Contract
            </button>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Supplier</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Cost Code</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Contract</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Released</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Remaining</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map(c => {
                    const remaining = c.contract_remaining ?? c.contract_value ?? 0
                    return (
                      <tr key={c.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors">
                        <td className="px-4 py-2.5 max-w-0"><p className="text-[#0F172A] font-medium truncate" title={c.to_company_name}>{c.to_company_name}</p></td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{c.cost_code || "—"}</td>
                        <td className="px-4 py-2.5 text-[#0F172A] text-[12px] tabular-nums font-medium">{c.contract_value != null ? usd0(c.contract_value) : "—"}</td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px] tabular-nums">{usd0(c.released_to_children ?? 0)}</td>
                        <td className={`px-4 py-2.5 text-[12px] tabular-nums font-medium ${remaining < 0 ? "text-amber-700" : "text-[#0F172A]"}`}>{usd0(remaining)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEdit(c)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Edit</button>
                            <button onClick={() => deleteContract(c.id)} className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden px-3 py-3 space-y-2">
              {contracts.map(c => {
                const remaining = c.contract_remaining ?? c.contract_value ?? 0
                return (
                  <div key={c.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                    <p className="text-[13px] font-medium text-[#0F172A] mb-1">{c.to_company_name}</p>
                    {c.cost_code && <p className="text-[11px] text-[#64748B] mb-1.5">Cost code {c.cost_code}</p>}
                    <div className="flex items-center gap-3 mb-2 text-[11px]">
                      <span className="text-[#64748B]">Contract <span className="font-semibold text-[#0F172A] tabular-nums">{c.contract_value != null ? usd0(c.contract_value) : "—"}</span></span>
                      <span className="text-[#64748B]">Released <span className="font-semibold text-[#0F172A] tabular-nums">{usd0(c.released_to_children ?? 0)}</span></span>
                      <span className="text-[#64748B]">Rem. <span className={`font-semibold tabular-nums ${remaining < 0 ? "text-amber-700" : "text-[#0F172A]"}`}>{usd0(remaining)}</span></span>
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(c)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                      <button onClick={() => deleteContract(c.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* New / Edit supplier contract modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) closeForm() }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[560px] mx-4 sm:mx-0 flex flex-col max-h-[92vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">{editingId ? "Edit Supplier Contract" : "New Supplier Contract"}</h2>
              <button onClick={closeForm} className="text-[#64748B] hover:text-[#0F172A] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>

            <div className="px-6 py-4 space-y-4 overflow-y-auto">
              {/* Vendor (suppliers + subcontractors) */}
              <div>
                <label className={labelCls}>Supplier <span className="text-red-400">*</span></label>
                <VendorPicker vendor={vendor} onChange={setVendor} role="supplier_or_subcontractor" placeholder="Select a supplier…" />
                {vendor && (vendor.street_address || vendor.city) && (
                  <p className="mt-1.5 text-[11px] text-[#64748B]">
                    {[vendor.street_address, [vendor.city, vendor.state].filter(Boolean).join(", "), vendor.zip_code].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>

              {/* Contract value + cost code */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Contract Value</label>
                  <input type="text" inputMode="decimal" value={contractValue} onChange={e => setContractValue(e.target.value)} placeholder="e.g. 250,000" className={inputCls} />
                  {previewValue != null && <p className="mt-1.5 text-[11px] text-[#64748B] tabular-nums">{usd0(previewValue)}</p>}
                </div>
                <div className="flex-1">
                  <label className={labelCls}>Cost Code</label>
                  <input type="text" value={costCode} onChange={e => setCostCode(e.target.value)} placeholder="e.g. 03 30 00" className={inputCls} />
                </div>
              </div>

              {/* Terms */}
              <div>
                <label className={labelCls}>Terms</label>
                <input type="text" value={terms} onChange={e => setTerms(e.target.value)} placeholder="e.g. Net 30" className={inputCls} />
              </div>

              {/* Notes */}
              <div>
                <label className={labelCls}>Notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Optional" className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
              </div>

              {editingId && (
                <p className="text-[11px] text-[#94A3B8]">Released-to-date and remaining are computed from the POs released against this contract and shown on the Commitments list.</p>
              )}

              {formError && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{formError}</div>}
            </div>

            <div className="flex justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <div>
                {editingId && (
                  <button type="button" onClick={() => deleteContract(editingId)} className="h-8 px-4 rounded-md border border-red-200 text-[13px] text-red-500 hover:bg-red-50 transition-colors">Delete</button>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={closeForm} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="button" onClick={save} disabled={saving || !vendor}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {saving && <SpinnerIcon className="h-3 w-3" />} {saving ? "Saving…" : editingId ? "Save contract" : "Create contract"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
