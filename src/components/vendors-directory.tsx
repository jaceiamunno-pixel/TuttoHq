"use client"

import { useState, useEffect, useCallback } from "react"
import VendorImportModal from "./vendor-import-modal"

// Unified Vendors directory (Settings → Directories → Vendors). Replaces the
// former separate Subcontractors and Suppliers panels — one list over the
// unified `vendors` master, with the sub/supplier distinction expressed as two
// independent flags (both-on = "Both", both-off = "Untyped"). People under each
// firm (vendor_people) are managed inline on the edit form.
//
// Tenant scope is enforced server-side: every read/write goes through the
// /api/vendors* routes, where RLS confines rows to the caller's company and the
// column DEFAULT owns company_id. The client never sends one.

export interface VendorFull {
  id: string
  vendor_no: string | null
  company_name: string
  is_subcontractor: boolean
  is_supplier: boolean
  trade: string | null
  specialty: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  street_address: string | null
  city: string | null
  state: string | null
  zip_code: string | null
  license_number: string | null
  website: string | null
  notes: string | null
}

interface VendorPerson {
  id: string
  vendor_id: string
  name: string | null
  email: string | null
  phone: string | null
  role: string | null
}

type FormState = {
  company_name: string; vendor_no: string; trade: string; specialty: string
  contact_name: string; phone: string; email: string; street_address: string
  city: string; state: string; zip_code: string; license_number: string
  website: string; notes: string; is_subcontractor: boolean; is_supplier: boolean
}

const EMPTY_FORM: FormState = {
  company_name: "", vendor_no: "", trade: "", specialty: "", contact_name: "",
  phone: "", email: "", street_address: "", city: "", state: "", zip_code: "",
  license_number: "", website: "", notes: "", is_subcontractor: false, is_supplier: false,
}

const inputCls = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#64748B] transition-all"
const labelCls = "block text-[12px] font-medium text-[#64748B] mb-1"

function vendorType(v: { is_subcontractor: boolean; is_supplier: boolean }): { label: string; cls: string } {
  if (v.is_subcontractor && v.is_supplier) return { label: "Both", cls: "bg-violet-50 text-violet-700 border-violet-200" }
  if (v.is_subcontractor) return { label: "Sub", cls: "bg-blue-50 text-blue-700 border-blue-200" }
  if (v.is_supplier) return { label: "Supplier", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" }
  return { label: "Untyped", cls: "bg-slate-50 text-slate-500 border-slate-200" }
}

function XIcon({ className = "h-3 w-3" }: { className?: string }) {
  return <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
}
function PencilIcon() {
  return <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.5-6.5a2.121 2.121 0 013 3L12 16H9v-3z" /></svg>
}
function PlusIcon() {
  return <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase()
}

export default function VendorsDirectory({ switcher }: { switcher: React.ReactNode }) {
  const [vendors, setVendors] = useState<VendorFull[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<VendorFull | null>(null)   // null = creating
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [importOpen, setImportOpen] = useState(false)

  const flash = useCallback((text: string, ok = true) => {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 3000)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    fetch("/api/vendors?all=1")
      .then(r => r.json())
      .then(d => setVendors(Array.isArray(d.vendors) ? d.vendors : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const ql = query.trim().toLowerCase()
  const filtered = ql
    ? vendors.filter(v =>
        v.company_name.toLowerCase().includes(ql) ||
        (v.trade ?? "").toLowerCase().includes(ql) ||
        (v.specialty ?? "").toLowerCase().includes(ql))
    : vendors

  function openAdd() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function openEdit(v: VendorFull) {
    setEditing(v)
    setForm({
      company_name: v.company_name, vendor_no: v.vendor_no ?? "", trade: v.trade ?? "",
      specialty: v.specialty ?? "", contact_name: v.contact_name ?? "", phone: v.phone ?? "",
      email: v.email ?? "", street_address: v.street_address ?? "", city: v.city ?? "",
      state: v.state ?? "", zip_code: v.zip_code ?? "", license_number: v.license_number ?? "",
      website: v.website ?? "", notes: v.notes ?? "",
      is_subcontractor: v.is_subcontractor, is_supplier: v.is_supplier,
    })
    setShowForm(true)
  }

  function cancelForm() {
    setShowForm(false)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  async function saveVendor(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name.trim()) return
    setSaving(true)
    try {
      const url = editing ? `/api/vendors/${editing.id}` : "/api/vendors"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      const saved = data.vendor as VendorFull
      if (editing) {
        setVendors(prev => prev.map(v => v.id === saved.id ? saved : v).sort((a, b) => a.company_name.localeCompare(b.company_name)))
        setEditing(saved)   // stay open so people can be managed
        flash("Vendor updated")
      } else {
        setVendors(prev => [...prev, saved].sort((a, b) => a.company_name.localeCompare(b.company_name)))
        setEditing(saved)   // switch to edit mode so people can be added to the new firm
        flash("Vendor added")
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : "Save failed", false)
    } finally {
      setSaving(false)
    }
  }

  async function deleteVendor(v: VendorFull) {
    if (!window.confirm(`Delete ${v.company_name}? This also removes its people.`)) return
    const res = await fetch(`/api/vendors/${v.id}`, { method: "DELETE" })
    if (res.ok) { setVendors(prev => prev.filter(x => x.id !== v.id)); flash("Deleted") }
    else flash("Delete failed", false)
  }

  const existingNames = new Set(vendors.map(v => normalizeName(v.company_name)))

  return (
    <div className="space-y-4">
      {switcher}
      {message && <div className={`px-4 py-2.5 rounded-lg text-[13px] ${message.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>{message.text}</div>}

      <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-[14px] font-semibold text-[#0F172A]">Vendors</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">One master list of subcontractors &amp; suppliers, reusable across all projects.</p>
          </div>
          {!showForm && (
            <div className="flex items-center gap-2">
              <button onClick={() => setImportOpen(true)} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-medium text-[#64748B] hover:text-[#0F172A] hover:border-[#7B9BB5]/60 transition-colors">Import spreadsheet</button>
              <button onClick={openAdd} className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5"><PlusIcon /> Add vendor</button>
            </div>
          )}
        </div>

        {showForm ? (
          <VendorForm
            editing={editing}
            form={form}
            setForm={setForm}
            saving={saving}
            onSubmit={saveVendor}
            onCancel={cancelForm}
          />
        ) : (
          <>
            <div className="px-5 py-3 border-b border-[#E2E8F0]">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by company, trade, or specialty…"
                className={inputCls}
              />
            </div>

            {loading && <div className="px-5 py-4 text-[13px] text-[#64748B]">Loading…</div>}
            {!loading && filtered.length === 0 && (
              <div className="px-5 py-8 text-center">
                <p className="text-[13px] text-[#64748B]">{vendors.length === 0 ? "No vendors yet." : "No vendors match your search."}</p>
              </div>
            )}
            {!loading && filtered.length > 0 && (
              <>
                <div className="px-5 py-2 text-[11px] text-[#94A3B8] border-b border-[#E2E8F0]">
                  {filtered.length === vendors.length ? `${vendors.length} vendors` : `${filtered.length} of ${vendors.length} vendors`}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-[#F8F9FA]">
                      <tr className="border-b border-[#E2E8F0]">
                        <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Company</th>
                        <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Type</th>
                        <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Trade / Specialty</th>
                        <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Contact</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((v, i) => {
                        const t = vendorType(v)
                        return (
                          <tr key={v.id} className={`${i < filtered.length - 1 ? "border-b border-[#E2E8F0]" : ""} hover:bg-[#F8F9FA] transition-colors`}>
                            <td className="px-4 py-2.5 text-[13px] font-medium text-[#0F172A]">{v.company_name}</td>
                            <td className="px-4 py-2.5"><span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${t.cls}`}>{t.label}</span></td>
                            <td className="px-4 py-2.5 text-[12px] text-[#64748B]">{v.trade || v.specialty || "—"}</td>
                            <td className="px-4 py-2.5 text-[12px] text-[#64748B]">{v.contact_name ?? "—"}</td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <button onClick={() => openEdit(v)} className="p-1 rounded text-[#64748B] hover:text-[#0F172A] transition-colors mr-1"><PencilIcon /></button>
                              <button onClick={() => deleteVendor(v)} className="p-1 rounded text-[#64748B] hover:text-red-400 transition-colors"><XIcon /></button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {importOpen && (
        <VendorImportModal
          existingNames={existingNames}
          onClose={() => setImportOpen(false)}
          onDone={(summary) => {
            setImportOpen(false)
            flash(`Imported ${summary.inserted} vendor${summary.inserted !== 1 ? "s" : ""}${summary.skipped ? `, ${summary.skipped} skipped as duplicates` : ""}.`)
            load()
          }}
        />
      )}
    </div>
  )
}

// ── Add / edit form (firm fields + two independent type toggles + people) ─────
function VendorForm({
  editing, form, setForm, saving, onSubmit, onCancel,
}: {
  editing: VendorFull | null
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  saving: boolean
  onSubmit: (e: React.FormEvent) => void
  onCancel: () => void
}) {
  const set = (k: keyof FormState) => (v: string) => setForm(p => ({ ...p, [k]: v }))
  const t = vendorType(form)

  return (
    <div className="px-5 py-4 bg-[#F4F5F7]/50">
      <p className="text-[13px] font-semibold text-[#0F172A] mb-3">{editing ? "Edit vendor" : "New vendor"}</p>
      <form onSubmit={onSubmit} className="space-y-4">
        {/* type toggles */}
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-[#0F172A] cursor-pointer select-none">
            <input type="checkbox" checked={form.is_subcontractor} onChange={e => setForm(p => ({ ...p, is_subcontractor: e.target.checked }))} className="h-4 w-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]/40" />
            Subcontractor
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[#0F172A] cursor-pointer select-none">
            <input type="checkbox" checked={form.is_supplier} onChange={e => setForm(p => ({ ...p, is_supplier: e.target.checked }))} className="h-4 w-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]/40" />
            Supplier
          </label>
          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${t.cls}`}>{t.label}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className={labelCls}>Company Name<span className="text-red-400"> *</span></label>
            <input value={form.company_name} onChange={e => set("company_name")(e.target.value)} required autoFocus placeholder="e.g. ABC Electrical" className={inputCls} />
          </div>
          <div><label className={labelCls}>Vendor No.</label><input value={form.vendor_no} onChange={e => set("vendor_no")(e.target.value)} placeholder="Optional" className={inputCls} /></div>
          <div><label className={labelCls}>Contact Name</label><input value={form.contact_name} onChange={e => set("contact_name")(e.target.value)} placeholder="John Smith" className={inputCls} /></div>
          <div><label className={labelCls}>Trade</label><input value={form.trade} onChange={e => set("trade")(e.target.value)} placeholder="e.g. Electrical" className={inputCls} /></div>
          <div><label className={labelCls}>Material / Specialty</label><input value={form.specialty} onChange={e => set("specialty")(e.target.value)} placeholder="e.g. Structural Steel" className={inputCls} /></div>
          <div><label className={labelCls}>Phone</label><input value={form.phone} onChange={e => set("phone")(e.target.value)} placeholder="555-000-1234" className={inputCls} /></div>
          <div><label className={labelCls}>Email</label><input value={form.email} onChange={e => set("email")(e.target.value)} placeholder="contact@company.com" className={inputCls} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Street Address</label><input value={form.street_address} onChange={e => set("street_address")(e.target.value)} placeholder="123 Main St" className={inputCls} /></div>
          <div><label className={labelCls}>City</label><input value={form.city} onChange={e => set("city")(e.target.value)} placeholder="City" className={inputCls} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>State</label><input value={form.state} onChange={e => set("state")(e.target.value)} placeholder="CT" className={inputCls} /></div>
            <div><label className={labelCls}>ZIP</label><input value={form.zip_code} onChange={e => set("zip_code")(e.target.value)} placeholder="06000" className={inputCls} /></div>
          </div>
          <div><label className={labelCls}>License Number</label><input value={form.license_number} onChange={e => set("license_number")(e.target.value)} placeholder="LIC-123456" className={inputCls} /></div>
          <div><label className={labelCls}>Website</label><input value={form.website} onChange={e => set("website")(e.target.value)} placeholder="https://company.com" className={inputCls} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Notes</label><input value={form.notes} onChange={e => set("notes")(e.target.value)} placeholder="Any notes…" className={inputCls} /></div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] transition-colors">{editing ? "Done" : "Cancel"}</button>
          <button type="submit" disabled={saving || !form.company_name.trim()} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">{saving ? "Saving…" : editing ? "Save changes" : "Add vendor"}</button>
        </div>
      </form>

      {/* People sub-section — only once the firm exists (needs a vendor_id). */}
      {editing && <VendorPeoplePanel vendorId={editing.id} />}
    </div>
  )
}

// ── People under a firm (vendor_people) — list / add / edit / remove ──────────
function VendorPeoplePanel({ vendorId }: { vendorId: string }) {
  const [people, setPeople] = useState<VendorPerson[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)   // row being edited
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: "", email: "", phone: "", role: "" })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/vendor-people?vendor_id=${encodeURIComponent(vendorId)}`)
      .then(r => r.json())
      .then(d => setPeople(Array.isArray(d.people) ? d.people : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [vendorId])

  function startAdd() { setAdding(true); setEditingId(null); setDraft({ name: "", email: "", phone: "", role: "" }) }
  function startEdit(p: VendorPerson) {
    setEditingId(p.id); setAdding(false)
    setDraft({ name: p.name ?? "", email: p.email ?? "", phone: p.phone ?? "", role: p.role ?? "" })
  }
  function cancel() { setAdding(false); setEditingId(null) }

  async function save() {
    if (!draft.name.trim() || busy) return
    setBusy(true)
    try {
      if (editingId) {
        const res = await fetch(`/api/vendor-people/${editingId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
        })
        const data = await res.json()
        if (res.ok) setPeople(prev => prev.map(p => p.id === editingId ? data.person : p))
      } else {
        const res = await fetch("/api/vendor-people", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendor_id: vendorId, ...draft }),
        })
        const data = await res.json()
        if (res.ok) setPeople(prev => [...prev, data.person])
      }
      cancel()
    } finally {
      setBusy(false)
    }
  }

  async function remove(p: VendorPerson) {
    if (!window.confirm(`Remove ${p.name || "this person"}?`)) return
    const res = await fetch(`/api/vendor-people/${p.id}`, { method: "DELETE" })
    if (res.ok) setPeople(prev => prev.filter(x => x.id !== p.id))
  }

  const fieldCls = "w-full h-8 px-2 rounded border border-[#E2E8F0] text-[12px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"

  return (
    <div className="mt-5 pt-4 border-t border-[#E2E8F0]">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[12px] font-semibold text-[#0F172A]">People</p>
        {!adding && editingId === null && (
          <button type="button" onClick={startAdd} className="text-[12px] text-[#7B9BB5] hover:underline flex items-center gap-1"><PlusIcon /> Add person</button>
        )}
      </div>

      {loading ? (
        <p className="text-[12px] text-[#94A3B8]">Loading…</p>
      ) : (
        <div className="space-y-1.5">
          {people.length === 0 && !adding && <p className="text-[12px] text-[#94A3B8]">No people yet.</p>}

          {people.map(p => editingId === p.id ? (
            <PersonEditor key={p.id} draft={draft} setDraft={setDraft} busy={busy} fieldCls={fieldCls} onSave={save} onCancel={cancel} />
          ) : (
            <div key={p.id} className="flex items-center justify-between bg-white border border-[#E2E8F0] rounded-md px-3 py-1.5">
              <div className="min-w-0">
                <span className="text-[12px] font-medium text-[#0F172A]">{p.name || "(unnamed)"}</span>
                {p.role && <span className="text-[12px] text-[#94A3B8]"> · {p.role}</span>}
                {(p.email || p.phone) && <span className="text-[11px] text-[#94A3B8] block truncate">{[p.email, p.phone].filter(Boolean).join(" · ")}</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button type="button" onClick={() => startEdit(p)} className="p-1 rounded text-[#64748B] hover:text-[#0F172A]"><PencilIcon /></button>
                <button type="button" onClick={() => remove(p)} className="p-1 rounded text-[#64748B] hover:text-red-400"><XIcon /></button>
              </div>
            </div>
          ))}

          {adding && <PersonEditor draft={draft} setDraft={setDraft} busy={busy} fieldCls={fieldCls} onSave={save} onCancel={cancel} />}
        </div>
      )}
    </div>
  )
}

function PersonEditor({
  draft, setDraft, busy, fieldCls, onSave, onCancel,
}: {
  draft: { name: string; email: string; phone: string; role: string }
  setDraft: React.Dispatch<React.SetStateAction<{ name: string; email: string; phone: string; role: string }>>
  busy: boolean
  fieldCls: string
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="bg-white border border-[#7B9BB5]/40 rounded-md px-3 py-2 space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <input autoFocus value={draft.name} onChange={e => setDraft(p => ({ ...p, name: e.target.value }))} placeholder="Name *" className={fieldCls} />
        <input value={draft.role} onChange={e => setDraft(p => ({ ...p, role: e.target.value }))} placeholder="Role (e.g. PM)" className={fieldCls} />
        <input value={draft.email} onChange={e => setDraft(p => ({ ...p, email: e.target.value }))} placeholder="Email" className={fieldCls} />
        <input value={draft.phone} onChange={e => setDraft(p => ({ ...p, phone: e.target.value }))} placeholder="Phone" className={fieldCls} />
      </div>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#64748B]">Cancel</button>
        <button type="button" disabled={!draft.name.trim() || busy} onClick={onSave} className="h-7 px-3 rounded bg-[#7B9BB5] text-white text-[12px] font-semibold disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  )
}
