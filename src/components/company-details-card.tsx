"use client"

import { apiFetch } from "@/lib/api-client"
import { useEffect, useState } from "react"

// Company cover-header fields + default OH&P percent (Settings → Company).
// Feeds the PCO cover sheet header and prefills the PCO builder's OH&P input.
// Admin-only writes (server-enforced); `canEdit` gates the affordances.
//
// OH&P is stored as a FRACTION (0.15) but shown/edited as a PERCENT (15) here —
// converted at the API boundary.

interface CompanyFields {
  address_line1: string
  address_line2: string
  phone: string
  ohp_percent: string // percent as typed, e.g. "15"
}

const EMPTY: CompanyFields = { address_line1: "", address_line2: "", phone: "", ohp_percent: "" }

export default function CompanyDetailsCard({ canEdit }: { canEdit: boolean }) {
  const [form, setForm] = useState<CompanyFields>(EMPTY)
  const [saved, setSaved] = useState<CompanyFields>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    apiFetch("/api/settings")
      .then(r => r.json())
      .then((d: { address_line1?: string | null; address_line2?: string | null; phone?: string | null; default_oh_p_percent?: number | null }) => {
        const next: CompanyFields = {
          address_line1: d.address_line1 ?? "",
          address_line2: d.address_line2 ?? "",
          phone: d.phone ?? "",
          ohp_percent: d.default_oh_p_percent === null || d.default_oh_p_percent === undefined
            ? ""
            : String(+(d.default_oh_p_percent * 100).toFixed(4)),
        }
        setForm(next)
        setSaved(next)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const dirty = JSON.stringify(form) !== JSON.stringify(saved)

  // Validate the percent field for live feedback (server re-validates the fraction).
  const ohpError = (() => {
    if (form.ohp_percent.trim() === "") return null
    const n = Number(form.ohp_percent)
    if (!Number.isFinite(n) || n < 0 || n > 100) return "OH&P must be between 0 and 100%."
    return null
  })()

  function set(key: keyof CompanyFields, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function save() {
    if (ohpError) return
    setSaving(true)
    setMessage(null)
    try {
      const body = {
        address_line1: form.address_line1.trim() || null,
        address_line2: form.address_line2.trim() || null,
        phone: form.phone.trim() || null,
        default_oh_p_percent: form.ohp_percent.trim() === "" ? null : Number(form.ohp_percent) / 100,
      }
      const res = await apiFetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setMessage({ text: d.error ?? "Could not save", ok: false }); return }
      setSaved(form)
      setMessage({ text: "Company details saved.", ok: true })
      setTimeout(() => setMessage(null), 3000)
    } finally {
      setSaving(false)
    }
  }

  const inputCls = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5] disabled:bg-[#F8FAFC] disabled:text-[#64748B]"

  return (
    <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
      <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Company Details</h2>
      <p className="text-[12px] text-[#64748B] mb-4">
        Address and phone appear in the header of generated PCO cover sheets. The default OH&amp;P
        percent prefills new PCOs (you can still override it per PCO).
      </p>

      {loading ? (
        <div className="text-[13px] text-[#64748B]">Loading…</div>
      ) : (
        <div className="space-y-4 max-w-[460px]">
          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">Address line 1</label>
            <input className={inputCls} value={form.address_line1} disabled={!canEdit || saving}
              placeholder="123 Main St" onChange={e => set("address_line1", e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">Address line 2</label>
            <input className={inputCls} value={form.address_line2} disabled={!canEdit || saving}
              placeholder="Suite 200, City, ST 00000" onChange={e => set("address_line2", e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">Phone</label>
            <input className={inputCls} value={form.phone} disabled={!canEdit || saving}
              placeholder="(555) 555-5555" onChange={e => set("phone", e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">Default OH&amp;P %</label>
            <div className="relative w-32">
              <input className={`${inputCls} pr-7`} type="number" step="0.1" min="0" max="100"
                value={form.ohp_percent} disabled={!canEdit || saving} placeholder="15"
                onChange={e => set("ohp_percent", e.target.value)} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[#64748B]">%</span>
            </div>
            <p className="text-[11px] text-[#64748B] mt-1">Applied to labor + materials on a PCO (not subcontractor lines).</p>
          </div>

          {ohpError && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{ohpError}</div>
          )}
          {message && (
            <div className={`rounded-md px-3 py-2 text-[12px] ${message.ok ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-600"}`}>
              {message.text}
            </div>
          )}

          {canEdit ? (
            <div className="flex items-center gap-2 pt-1">
              <button onClick={save} disabled={!dirty || saving || !!ohpError}
                className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#5A7A94] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => { setForm(saved); setMessage(null) }} disabled={!dirty || saving}
                className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Cancel
              </button>
            </div>
          ) : (
            <p className="text-[11px] text-[#64748B]">Only company admins can edit these details.</p>
          )}
        </div>
      )}
    </div>
  )
}
