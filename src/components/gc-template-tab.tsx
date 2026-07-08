"use client"

import { useEffect, useState } from "react"

// GC Template (Settings → Company → GC Template). The company's reusable general-
// conditions block (site supervision, PM time, temp facilities, cleanup, etc.).
// Ships EMPTY — each tenant builds its own once. The generate-from-spec scaffold
// copies the ACTIVE rows into a new estimate as source='gc_template' lines. Writes
// are admin-only (server-enforced; canEdit only gates the affordances).

const CATEGORIES = ["labor", "material", "subcontractor", "equipment", "other"] as const
type Category = (typeof CATEGORIES)[number]

interface Item {
  id: string
  description: string
  category: Category
  default_qty: number | null
  default_unit: string | null
  default_unit_cost: number | null
  sort_order: number | null
  active: boolean
}
type Row = Item & { _draft?: boolean }

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v))
let draftSeq = 0

export default function GcTemplateTab({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [saved, setSaved] = useState<Record<string, Item>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  function flash(text: string, ok = true) {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 3000)
  }

  useEffect(() => {
    fetch("/api/gc-template-items")
      .then(r => r.json())
      .then((d: { items?: Item[] }) => {
        const items = d.items ?? []
        setRows(items)
        setSaved(Object.fromEntries(items.map(i => [i.id, i])))
      })
      .catch(() => flash("Could not load GC template", false))
      .finally(() => setLoading(false))
  }, [])

  function patchRow(id: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }

  function isDirty(row: Row): boolean {
    if (row._draft) return true
    const s = saved[row.id]
    if (!s) return true
    return (
      row.description !== s.description || row.category !== s.category ||
      row.default_qty !== s.default_qty || row.default_unit !== s.default_unit ||
      row.default_unit_cost !== s.default_unit_cost || row.sort_order !== s.sort_order ||
      row.active !== s.active
    )
  }

  function addDraft() {
    const id = `draft-${draftSeq++}`
    setRows(prev => [
      ...prev,
      { id, description: "", category: "other", default_qty: null, default_unit: null, default_unit_cost: null, sort_order: null, active: true, _draft: true },
    ])
  }

  async function saveRow(row: Row) {
    if (!row.description.trim()) { flash("Description is required", false); return }
    setBusyId(row.id)
    try {
      const payload = {
        description: row.description.trim(),
        category: row.category,
        default_qty: row.default_qty,
        default_unit: row.default_unit,
        default_unit_cost: row.default_unit_cost,
        sort_order: row.sort_order,
        active: row.active,
      }
      const res = row._draft
        ? await fetch("/api/gc-template-items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch(`/api/gc-template-items/${row.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? "Save failed", false); return }
      const item: Item = d.item
      setRows(prev => prev.map(r => (r.id === row.id ? item : r)))
      setSaved(prev => ({ ...prev, [item.id]: item }))
      flash("Saved")
    } finally {
      setBusyId(null)
    }
  }

  async function deleteRow(row: Row) {
    if (row._draft) { setRows(prev => prev.filter(r => r.id !== row.id)); return }
    if (!window.confirm(`Delete "${row.description}"?`)) return
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/gc-template-items/${row.id}`, { method: "DELETE" })
      if (!res.ok) { const d = await res.json().catch(() => ({})); flash(d.error ?? "Delete failed", false); return }
      setRows(prev => prev.filter(r => r.id !== row.id))
      setSaved(prev => { const next = { ...prev }; delete next[row.id]; return next })
      flash("Item deleted")
    } finally {
      setBusyId(null)
    }
  }

  const cell = "w-full h-8 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5] disabled:bg-[#F8FAFC] disabled:text-[#64748B]"

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">GC Template</h2>
            <p className="text-[12px] text-[#64748B]">
              Your reusable general-conditions rows. &ldquo;Generate estimate&rdquo; scaffolds the active rows
              into every new bid. Ships empty — build your own once.
            </p>
          </div>
          {canEdit && (
            <button onClick={addDraft}
              className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#5A7A94] transition-colors flex-shrink-0">
              + Add item
            </button>
          )}
        </div>

        {loading ? (
          <div className="text-[13px] text-[#64748B]">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-[13px] text-[#64748B] py-6 text-center">
            No GC template items yet.{canEdit ? " Add your first row to build the template." : ""}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold text-[#64748B] text-left border-b border-[#E2E8F0]">
                  <th className="py-2 pr-2 w-[30%]">Description</th>
                  <th className="py-2 px-2 w-[130px]">Category</th>
                  <th className="py-2 px-2 w-[80px]">Qty</th>
                  <th className="py-2 px-2 w-[80px]">Unit</th>
                  <th className="py-2 px-2 w-[110px]">Unit cost</th>
                  <th className="py-2 px-2 w-[64px]">Order</th>
                  <th className="py-2 px-2 w-[56px] text-center">Active</th>
                  <th className="py-2 pl-2 w-[120px]" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const dirty = isDirty(row)
                  const busy = busyId === row.id
                  return (
                    <tr key={row.id} className="border-b border-[#F1F5F9] last:border-0">
                      <td className="py-2 pr-2">
                        {canEdit
                          ? <input className={cell} value={row.description} placeholder="e.g. Site supervision"
                              onChange={e => patchRow(row.id, { description: e.target.value })} disabled={busy} />
                          : <span className="text-[#0F172A]">{row.description}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {canEdit
                          ? <select className={cell} value={row.category} disabled={busy}
                              onChange={e => patchRow(row.id, { category: e.target.value as Category })}>
                              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          : <span className="text-[#64748B]">{row.category}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {canEdit
                          ? <input className={`${cell} text-right`} type="number" step="0.0001" value={row.default_qty ?? ""} placeholder="—"
                              onChange={e => patchRow(row.id, { default_qty: num(e.target.value) })} disabled={busy} />
                          : <span className="text-[#64748B]">{row.default_qty ?? "—"}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {canEdit
                          ? <input className={cell} value={row.default_unit ?? ""} placeholder="—"
                              onChange={e => patchRow(row.id, { default_unit: e.target.value.trim() || null })} disabled={busy} />
                          : <span className="text-[#64748B]">{row.default_unit ?? "—"}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {canEdit
                          ? <input className={`${cell} text-right`} type="number" step="0.01" value={row.default_unit_cost ?? ""} placeholder="—"
                              onChange={e => patchRow(row.id, { default_unit_cost: num(e.target.value) })} disabled={busy} />
                          : <span className="text-[#64748B]">{row.default_unit_cost ?? "—"}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {canEdit
                          ? <input className={cell} type="number" value={row.sort_order ?? ""}
                              onChange={e => patchRow(row.id, { sort_order: num(e.target.value) })} disabled={busy} />
                          : <span className="text-[#64748B]">{row.sort_order ?? "—"}</span>}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <input type="checkbox" checked={row.active} disabled={!canEdit || busy}
                          onChange={e => patchRow(row.id, { active: e.target.checked })}
                          className="h-4 w-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]" />
                      </td>
                      <td className="py-2 pl-2">
                        {canEdit && (
                          <div className="flex items-center gap-1.5 justify-end">
                            <button onClick={() => saveRow(row)} disabled={!dirty || busy}
                              className="h-7 px-2.5 rounded-md bg-[#7B9BB5] text-white text-[11px] font-semibold hover:bg-[#5A7A94] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                              {busy ? "…" : "Save"}
                            </button>
                            <button onClick={() => deleteRow(row)} disabled={busy}
                              className="h-7 px-2.5 rounded-md border border-[#E2E8F0] text-[11px] font-semibold text-[#DC2626] hover:bg-red-50 transition-colors disabled:opacity-40">
                              {row._draft ? "Discard" : "Delete"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!canEdit && <p className="text-[11px] text-[#64748B] mt-4">Only company admins can edit the GC template.</p>}
        {message && (
          <div className={`mt-4 rounded-md px-3 py-2 text-[12px] ${message.ok ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-600"}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  )
}
