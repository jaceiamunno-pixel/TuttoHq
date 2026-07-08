"use client"

import { useEffect, useState } from "react"

// Company Bid Defaults (Settings → Company → Bid Defaults). One row per company.
// GENERAL-SOFTWARE RULE (ADR-015): these are the tenant's OWN numbers. Only the
// "10-10 rule" (overhead 10% / profit 10%) has an industry default; burden, tax
// rate and bond have no national default and ship "not set" — shown blank with
// helper text, NEVER as 0. A generated estimate snapshots these values, so editing
// them here never reprices an existing bid. Writes are admin-only (server-enforced;
// canEdit only gates the affordances).

interface Defaults {
  overhead_pct: number | null
  profit_pct: number | null
  labor_burden_pct: number | null
  material_tax_exempt: boolean
  equip_material_tax_rate: number | null
  bond_pct: number | null
  permit_basis_note: string | null
}

// fraction (0.10) ↔ percent input string ("10"). Empty string ⇒ "not set" (null).
const toPct = (frac: number | null | undefined) =>
  frac === null || frac === undefined ? "" : String(+(frac * 100).toFixed(4))
const toFrac = (s: string): number | null => (s.trim() === "" ? null : Number(s) / 100)

export default function BidDefaultsTab({ canEdit }: { canEdit: boolean }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [overhead, setOverhead] = useState("10")
  const [profit, setProfit] = useState("10")
  const [burden, setBurden] = useState("")
  const [taxExempt, setTaxExempt] = useState(true)
  const [taxRate, setTaxRate] = useState("")
  const [bond, setBond] = useState("")
  const [permitNote, setPermitNote] = useState("")

  function flash(text: string, ok = true) {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 3000)
  }

  useEffect(() => {
    fetch("/api/company-bid-defaults")
      .then(r => r.json())
      .then((d: { defaults: Defaults | null }) => {
        const x = d.defaults
        if (x) {
          setOverhead(toPct(x.overhead_pct))
          setProfit(toPct(x.profit_pct))
          setBurden(toPct(x.labor_burden_pct))
          setTaxExempt(x.material_tax_exempt)
          setTaxRate(toPct(x.equip_material_tax_rate))
          setBond(toPct(x.bond_pct))
          setPermitNote(x.permit_basis_note ?? "")
        }
      })
      .catch(() => flash("Could not load bid defaults", false))
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const body = {
        overhead_pct: toFrac(overhead),
        profit_pct: toFrac(profit),
        labor_burden_pct: toFrac(burden),
        material_tax_exempt: taxExempt,
        equip_material_tax_rate: toFrac(taxRate),
        bond_pct: toFrac(bond),
        permit_basis_note: permitNote.trim() || null,
      }
      const res = await fetch("/api/company-bid-defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? "Save failed", false); return }
      flash("Bid defaults saved")
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5] disabled:bg-[#F8FAFC] disabled:text-[#64748B]"
  const labelCls = "block text-[12px] font-medium text-[#0F172A] mb-1"

  // A percent field with a trailing "%" and, when blank + nullable, an amber
  // "not set" hint (never rendered as 0 — that would silently understate a bid).
  function PctField({
    label, value, onChange, seededHint, nullableHint,
  }: {
    label: string; value: string; onChange: (v: string) => void
    seededHint?: string; nullableHint?: string
  }) {
    const notSet = value.trim() === "" && !!nullableHint
    return (
      <div>
        <label className={labelCls}>{label}</label>
        <div className="relative">
          <input
            className={`${inputCls} pr-7 ${notSet ? "border-amber-300 bg-amber-50/40" : ""}`}
            type="number" step="0.01" min="0" inputMode="decimal"
            value={value} placeholder="—"
            onChange={e => onChange(e.target.value)} disabled={!canEdit}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[#64748B]">%</span>
        </div>
        {notSet
          ? <p className="text-[11px] text-amber-600 mt-1">Not set — required before an estimate calculates.</p>
          : seededHint
            ? <p className="text-[11px] text-[#94A3B8] mt-1">{seededHint}</p>
            : null}
      </div>
    )
  }

  if (loading) return <div className="text-[13px] text-[#64748B]">Loading…</div>

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
        <div className="mb-4">
          <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Bid Defaults</h2>
          <p className="text-[12px] text-[#64748B]">
            Your company&apos;s bid parameters. Overhead and profit seed the industry
            &ldquo;10-10 rule&rdquo;; burden, tax and bond have no national default — set them before your
            first estimate. A generated estimate snapshots these, so editing here never reprices an existing bid.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[560px]">
          <PctField label="Overhead" value={overhead} onChange={setOverhead} seededHint="10-10 rule default." />
          <PctField label="Profit" value={profit} onChange={setProfit} seededHint="10-10 rule default." />
          <PctField label="Labor burden" value={burden} onChange={setBurden} nullableHint="not set" />
          <PctField label="Bond" value={bond} onChange={setBond} nullableHint="not set" />
        </div>

        <div className="border-t border-[#F1F5F9] mt-5 pt-4 max-w-[560px]">
          <label className="flex items-center gap-2 mb-3">
            <input type="checkbox" checked={taxExempt} disabled={!canEdit}
              onChange={e => setTaxExempt(e.target.checked)}
              className="h-4 w-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]" />
            <span className="text-[13px] text-[#0F172A]">Material is sales-tax exempt</span>
          </label>
          {!taxExempt && (
            <div className="max-w-[270px]">
              <PctField label="Equipment / material tax rate" value={taxRate} onChange={setTaxRate} nullableHint="not set" />
            </div>
          )}
          {taxExempt && (
            <p className="text-[11px] text-[#94A3B8]">Uncheck to enter a per-tenant sales-tax rate (e.g. your state rate).</p>
          )}
        </div>

        <div className="border-t border-[#F1F5F9] mt-5 pt-4 max-w-[560px]">
          <label className={labelCls}>Permit basis note</label>
          <input className={inputCls} value={permitNote} placeholder="How you figure permit — a reminder; permit is a per-estimate dollar field"
            onChange={e => setPermitNote(e.target.value)} disabled={!canEdit} />
          <p className="text-[11px] text-[#94A3B8] mt-1">
            Permit is entered as a discrete dollar amount on each estimate — this note is just your reminder of the basis.
          </p>
        </div>

        {canEdit && (
          <div className="mt-6 flex items-center gap-3">
            <button onClick={save} disabled={saving}
              className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
              {saving ? "Saving…" : "Save bid defaults"}
            </button>
          </div>
        )}
        {!canEdit && <p className="text-[11px] text-[#64748B] mt-4">Only company admins can edit bid defaults.</p>}
        {message && (
          <div className={`mt-4 rounded-md px-3 py-2 text-[12px] ${message.ok ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-600"}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  )
}
