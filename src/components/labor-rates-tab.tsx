"use client"

import { apiFetch } from "@/lib/api-client"
import { useEffect, useState } from "react"

// Company labor rate book (Settings → Labor Rates). Reads are open to any
// company member; create/update/delete are admin-only and the server enforces
// it — `canEdit` only gates the affordances. The PCO builder (Phase 2) snapshots
// these rates into each PCO, so editing the book never reprices an existing PCO.

interface Rate {
  id: string
  role_name: string
  reg_rate: number | null
  ot_rate: number | null
  dt_rate: number | null
  sort_order: number | null
  active: boolean
}

type Row = Rate & { _draft?: boolean }

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v))
const money = (n: number | null) => (n === null || n === undefined ? "—" : n.toFixed(2))

let draftSeq = 0

export default function LaborRatesTab({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [saved, setSaved] = useState<Record<string, Rate>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  function flash(text: string, ok = true) {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 3000)
  }

  useEffect(() => {
    apiFetch("/api/labor-rates")
      .then(r => r.json())
      .then((d: { rates?: Rate[] }) => {
        const rates = d.rates ?? []
        setRows(rates)
        setSaved(Object.fromEntries(rates.map(r => [r.id, r])))
      })
      .catch(() => flash("Could not load labor rates", false))
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
      row.role_name !== s.role_name ||
      row.reg_rate !== s.reg_rate ||
      row.ot_rate !== s.ot_rate ||
      row.dt_rate !== s.dt_rate ||
      row.sort_order !== s.sort_order ||
      row.active !== s.active
    )
  }

  function addDraft() {
    const id = `draft-${draftSeq++}`
    setRows(prev => [
      ...prev,
      { id, role_name: "", reg_rate: null, ot_rate: null, dt_rate: null, sort_order: null, active: true, _draft: true },
    ])
  }

  async function saveRow(row: Row) {
    if (!row.role_name.trim()) { flash("Role name is required", false); return }
    setBusyId(row.id)
    try {
      const payload = {
        role_name: row.role_name.trim(),
        reg_rate: row.reg_rate,
        ot_rate: row.ot_rate,
        dt_rate: row.dt_rate,
        sort_order: row.sort_order,
        active: row.active,
      }
      const res = row._draft
        ? await apiFetch("/api/labor-rates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await apiFetch(`/api/labor-rates/${row.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? "Save failed", false); return }
      const rate: Rate = d.rate
      setRows(prev => prev.map(r => (r.id === row.id ? rate : r)))
      setSaved(prev => ({ ...prev, [rate.id]: rate }))
      flash("Saved")
    } finally {
      setBusyId(null)
    }
  }

  async function deleteRow(row: Row) {
    if (row._draft) { setRows(prev => prev.filter(r => r.id !== row.id)); return }
    if (!window.confirm(`Delete rate "${row.role_name}"?`)) return
    setBusyId(row.id)
    try {
      const res = await apiFetch(`/api/labor-rates/${row.id}`, { method: "DELETE" })
      if (!res.ok) { const d = await res.json().catch(() => ({})); flash(d.error ?? "Delete failed", false); return }
      setRows(prev => prev.filter(r => r.id !== row.id))
      setSaved(prev => { const next = { ...prev }; delete next[row.id]; return next })
      flash("Rate deleted")
    } finally {
      setBusyId(null)
    }
  }

  const inputCls = "w-full h-8 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5] disabled:bg-[#F8FAFC] disabled:text-[#64748B]"

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Labor Rates</h2>
            <p className="text-[12px] text-[#64748B]">
              Your company&apos;s hourly rate book. New PCOs prefill from the active rows; editing a
              rate here never changes a PCO you already created.
            </p>
          </div>
          {canEdit && (
            <button
              onClick={addDraft}
              className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#5A7A94] transition-colors flex-shrink-0"
            >
              + Add rate
            </button>
          )}
        </div>

        {loading ? (
          <div className="text-[13px] text-[#64748B]">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-[13px] text-[#64748B] py-6 text-center">
            No labor rates yet.{canEdit ? " Add your first role to build the rate book." : ""}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold text-[#64748B] text-left border-b border-[#E2E8F0]">
                  <th className="py-2 pr-2 w-[34%]">Role</th>
                  <th className="py-2 px-2">Reg ($/hr)</th>
                  <th className="py-2 px-2">1.5× ($/hr)</th>
                  <th className="py-2 px-2">2× ($/hr)</th>
                  <th className="py-2 px-2 w-[64px]">Order</th>
                  <th className="py-2 px-2 w-[64px] text-center">Active</th>
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
                        {canEdit ? (
                          <input className={inputCls} value={row.role_name} placeholder="e.g. Carpenter Foreman"
                            onChange={e => patchRow(row.id, { role_name: e.target.value })} disabled={busy} />
                        ) : <span className="text-[#0F172A]">{row.role_name}</span>}
                      </td>
                      {(["reg_rate", "ot_rate", "dt_rate"] as const).map(field => (
                        <td key={field} className="py-2 px-2">
                          {canEdit ? (
                            <input className={inputCls} type="number" step="0.01" min="0"
                              value={row[field] ?? ""} placeholder="0.00"
                              onChange={e => patchRow(row.id, { [field]: num(e.target.value) } as Partial<Row>)} disabled={busy} />
                          ) : <span className="text-[#0F172A]">{money(row[field])}</span>}
                        </td>
                      ))}
                      <td className="py-2 px-2">
                        {canEdit ? (
                          <input className={inputCls} type="number" value={row.sort_order ?? ""}
                            onChange={e => patchRow(row.id, { sort_order: num(e.target.value) })} disabled={busy} />
                        ) : <span className="text-[#64748B]">{row.sort_order ?? "—"}</span>}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <input type="checkbox" checked={row.active}
                          onChange={e => patchRow(row.id, { active: e.target.checked })}
                          disabled={!canEdit || busy}
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

        {!canEdit && (
          <p className="text-[11px] text-[#64748B] mt-4">Only company admins can edit the rate book.</p>
        )}
        {message && (
          <div className={`mt-4 rounded-md px-3 py-2 text-[12px] ${message.ok ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-600"}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  )
}
