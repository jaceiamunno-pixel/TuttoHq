"use client"

import { useEffect, useMemo, useState } from "react"
import type { Project } from "../_shared/types"
import { computePcoTotals, laborLineTotal, materialLineTotal } from "../_shared/pco-math"

// PCO Builder — the Backup worksheet (Phase 2). Live pricing only; the cover
// sheet, save-to-log, and PDF export land in Phases 3–4. Mirrors THP's
// "SRC - THP PCO 054.xlsx" backup template. All math runs through pco-math so
// the figures here match the stored pricing_sum and the generated PDF.

interface LaborRow {
  id: string; description: string
  qty_reg: number | null; rate_reg: number | null
  qty_ot: number | null;  rate_ot: number | null
  qty_dt: number | null;  rate_dt: number | null
}
interface MaterialRow { id: string; description: string; qty: number | null; unit: string; unit_price: number | null; note: string }
interface SubRow { id: string; description: string; amount: number | null }

interface ActiveRate { id: string; role_name: string; reg_rate: number | null; ot_rate: number | null; dt_rate: number | null; active: boolean }

let seq = 0
const rid = (p: string) => `${p}-${seq++}`
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v))
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const hrs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

const emptyLabor = (): LaborRow => ({ id: rid("l"), description: "", qty_reg: null, rate_reg: null, qty_ot: null, rate_ot: null, qty_dt: null, rate_dt: null })
const emptyMaterial = (): MaterialRow => ({ id: rid("m"), description: "", qty: null, unit: "", unit_price: null, note: "" })
const emptySub = (): SubRow => ({ id: rid("s"), description: "", amount: null })

export default function PcoBuilder({ project, onClose }: { project: Project; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [pcoDisplay, setPcoDisplay] = useState("…")
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [labor, setLabor] = useState<LaborRow[]>([])
  const [materials, setMaterials] = useState<MaterialRow[]>([emptyMaterial()])
  const [subs, setSubs] = useState<SubRow[]>([emptySub()])
  const [ohpPercentInput, setOhpPercentInput] = useState("") // shown as percent (e.g. "15")

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch("/api/labor-rates").then(r => r.json()).catch(() => ({ rates: [] })),
      fetch("/api/settings").then(r => r.json()).catch(() => ({})),
      fetch(`/api/change-orders/next-number?project_id=${encodeURIComponent(project.id)}`).then(r => r.json()).catch(() => ({ display: "001" })),
    ]).then(([ratesRes, settings, numRes]) => {
      if (cancelled) return
      const active: ActiveRate[] = (ratesRes.rates ?? []).filter((r: ActiveRate) => r.active)
      // Seed one labor row per active rate, rates snapshotted in, quantities 0.
      setLabor(active.length
        ? active.map(r => ({ id: rid("l"), description: r.role_name, qty_reg: 0, rate_reg: r.reg_rate, qty_ot: 0, rate_ot: r.ot_rate, qty_dt: 0, rate_dt: r.dt_rate }))
        : [emptyLabor()])
      if (settings?.default_oh_p_percent != null) {
        setOhpPercentInput(String(+(settings.default_oh_p_percent * 100).toFixed(4)))
      }
      if (numRes?.display) setPcoDisplay(numRes.display)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [project.id])

  const ohpFraction = ohpPercentInput.trim() === "" ? 0 : Number(ohpPercentInput) / 100
  const ohpValid = ohpPercentInput.trim() === "" || (Number.isFinite(Number(ohpPercentInput)) && Number(ohpPercentInput) >= 0)

  const totals = useMemo(
    () => computePcoTotals(labor, materials, subs, Number.isFinite(ohpFraction) ? ohpFraction : 0),
    [labor, materials, subs, ohpFraction],
  )

  function setLaborField(id: string, field: keyof LaborRow, value: string | number | null) {
    setLabor(prev => prev.map(r => (r.id === id ? { ...r, [field]: value } : r)))
  }
  function setMaterialField(id: string, field: keyof MaterialRow, value: string | number | null) {
    setMaterials(prev => prev.map(r => (r.id === id ? { ...r, [field]: value } : r)))
  }
  function setSubField(id: string, field: keyof SubRow, value: string | number | null) {
    setSubs(prev => prev.map(r => (r.id === id ? { ...r, [field]: value } : r)))
  }

  const cell = "h-8 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
  const SectionHeader = ({ title, hint }: { title: string; hint?: string }) => (
    <div className="flex items-baseline justify-between mb-2">
      <h3 className="text-[13px] font-bold text-[#0F172A] uppercase tracking-wide">{title}</h3>
      {hint && <span className="text-[11px] text-[#64748B]">{hint}</span>}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-[#F4F5F7] w-full sm:max-w-[1080px] sm:rounded-xl shadow-xl flex flex-col max-h-screen sm:max-h-[94vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-[#E2E8F0] sm:rounded-t-xl flex-shrink-0">
          <div>
            <h2 className="text-[16px] font-bold text-[#0F172A]">New PCO — Pricing Backup</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">{project.name}</p>
          </div>
          <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-md text-[#64748B] hover:bg-[#F4F5F7] text-[18px]">×</button>
        </div>

        {loading ? (
          <div className="flex-1 grid place-items-center text-[13px] text-[#64748B] py-20">Loading rate book…</div>
        ) : (
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

            {/* Auto-filled header */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div>
                <div className="text-[11px] font-semibold text-[#64748B] uppercase">PCO #</div>
                <div className="text-[15px] font-mono font-bold text-[#7B9BB5] mt-0.5">{pcoDisplay}</div>
                <div className="text-[10px] text-[#94A3B8]">assigned on save</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-[#64748B] uppercase">Job #</div>
                <div className="text-[15px] font-mono text-[#0F172A] mt-0.5">{project.number || "—"}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-[#64748B] uppercase">Date</div>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`${cell} mt-0.5 w-full`} />
              </div>
            </div>

            {/* LABOR */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-4">
              <SectionHeader title="Labor" hint="Rates are snapshotted — editing them here won't change your rate book." />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead>
                    <tr className="text-[10px] font-semibold text-[#64748B] uppercase text-left border-b border-[#E2E8F0]">
                      <th className="py-1.5 pr-2 w-[26%]">Role</th>
                      <th className="py-1.5 px-1 text-right">Reg hrs</th>
                      <th className="py-1.5 px-1 text-right">Reg $/hr</th>
                      <th className="py-1.5 px-1 text-right">1.5× hrs</th>
                      <th className="py-1.5 px-1 text-right">1.5× $/hr</th>
                      <th className="py-1.5 px-1 text-right">2× hrs</th>
                      <th className="py-1.5 px-1 text-right">2× $/hr</th>
                      <th className="py-1.5 px-1 text-right w-[90px]">Total</th>
                      <th className="py-1.5 pl-1 w-[28px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {labor.map(row => (
                      <tr key={row.id} className="border-b border-[#F1F5F9]">
                        <td className="py-1.5 pr-2">
                          <input className={`${cell} w-full`} value={row.description} placeholder="Role"
                            onChange={e => setLaborField(row.id, "description", e.target.value)} />
                        </td>
                        {(["qty_reg", "rate_reg", "qty_ot", "rate_ot", "qty_dt", "rate_dt"] as const).map(f => (
                          <td key={f} className="py-1.5 px-1">
                            <input className={`${cell} w-full text-right`} type="number" step="0.01"
                              value={row[f] ?? ""} placeholder="0"
                              onChange={e => setLaborField(row.id, f, num(e.target.value))} />
                          </td>
                        ))}
                        <td className="py-1.5 px-1 text-right tabular-nums font-medium text-[#0F172A]">{usd(laborLineTotal(row))}</td>
                        <td className="py-1.5 pl-1 text-right">
                          <button onClick={() => setLabor(prev => prev.filter(r => r.id !== row.id))}
                            className="h-6 w-6 grid place-items-center rounded text-[#94A3B8] hover:text-[#DC2626] hover:bg-red-50">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="text-[12px] font-semibold text-[#0F172A] border-t-2 border-[#E2E8F0]">
                      <td className="py-2 pr-2">Subtotal</td>
                      <td className="py-2 px-1 text-right tabular-nums">{hrs(totals.hoursReg)}</td>
                      <td />
                      <td className="py-2 px-1 text-right tabular-nums">{hrs(totals.hoursOt)}</td>
                      <td />
                      <td className="py-2 px-1 text-right tabular-nums">{hrs(totals.hoursDt)}</td>
                      <td />
                      <td className="py-2 px-1 text-right tabular-nums">{usd(totals.laborSubtotal)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <button onClick={() => setLabor(prev => [...prev, emptyLabor()])}
                className="mt-2 h-7 px-2.5 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Add labor row</button>
            </div>

            {/* MATERIAL / EQUIPMENT */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-4">
              <SectionHeader title="Material / Equipment" />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-[13px]">
                  <thead>
                    <tr className="text-[10px] font-semibold text-[#64748B] uppercase text-left border-b border-[#E2E8F0]">
                      <th className="py-1.5 pr-2 w-[30%]">Description</th>
                      <th className="py-1.5 px-1 text-right w-[70px]">Qty</th>
                      <th className="py-1.5 px-1 w-[80px]">Unit</th>
                      <th className="py-1.5 px-1 text-right w-[110px]">Unit price</th>
                      <th className="py-1.5 px-1">Note</th>
                      <th className="py-1.5 px-1 text-right w-[90px]">Total</th>
                      <th className="py-1.5 pl-1 w-[28px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {materials.map(row => (
                      <tr key={row.id} className="border-b border-[#F1F5F9]">
                        <td className="py-1.5 pr-2"><input className={`${cell} w-full`} value={row.description} placeholder="Item"
                          onChange={e => setMaterialField(row.id, "description", e.target.value)} /></td>
                        <td className="py-1.5 px-1"><input className={`${cell} w-full text-right`} type="number" step="0.01" value={row.qty ?? ""} placeholder="0"
                          onChange={e => setMaterialField(row.id, "qty", num(e.target.value))} /></td>
                        <td className="py-1.5 px-1"><input className={`${cell} w-full`} value={row.unit} placeholder="ea"
                          onChange={e => setMaterialField(row.id, "unit", e.target.value)} /></td>
                        <td className="py-1.5 px-1"><input className={`${cell} w-full text-right`} type="number" step="0.01" value={row.unit_price ?? ""} placeholder="0.00"
                          onChange={e => setMaterialField(row.id, "unit_price", num(e.target.value))} /></td>
                        <td className="py-1.5 px-1"><input className={`${cell} w-full`} value={row.note} placeholder="ref"
                          onChange={e => setMaterialField(row.id, "note", e.target.value)} /></td>
                        <td className="py-1.5 px-1 text-right tabular-nums font-medium">{usd(materialLineTotal(row))}</td>
                        <td className="py-1.5 pl-1 text-right">
                          <button onClick={() => setMaterials(prev => prev.filter(r => r.id !== row.id))}
                            className="h-6 w-6 grid place-items-center rounded text-[#94A3B8] hover:text-[#DC2626] hover:bg-red-50">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="text-[12px] font-semibold text-[#0F172A] border-t-2 border-[#E2E8F0]">
                      <td className="py-2 pr-2" colSpan={5}>Materials subtotal</td>
                      <td className="py-2 px-1 text-right tabular-nums">{usd(totals.materialsSubtotal)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <button onClick={() => setMaterials(prev => [...prev, emptyMaterial()])}
                className="mt-2 h-7 px-2.5 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Add material row</button>
            </div>

            {/* SUBCONTRACTOR */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-4">
              <SectionHeader title="Subcontractor" hint="OH&P is not applied to subcontractor lines." />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-[13px]">
                  <thead>
                    <tr className="text-[10px] font-semibold text-[#64748B] uppercase text-left border-b border-[#E2E8F0]">
                      <th className="py-1.5 pr-2">Firm / description</th>
                      <th className="py-1.5 px-1 text-right w-[130px]">Amount</th>
                      <th className="py-1.5 pl-1 w-[28px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map(row => (
                      <tr key={row.id} className="border-b border-[#F1F5F9]">
                        <td className="py-1.5 pr-2"><input className={`${cell} w-full`} value={row.description} placeholder="Subcontractor"
                          onChange={e => setSubField(row.id, "description", e.target.value)} /></td>
                        <td className="py-1.5 px-1"><input className={`${cell} w-full text-right`} type="number" step="0.01" value={row.amount ?? ""} placeholder="0.00"
                          onChange={e => setSubField(row.id, "amount", num(e.target.value))} /></td>
                        <td className="py-1.5 pl-1 text-right">
                          <button onClick={() => setSubs(prev => prev.filter(r => r.id !== row.id))}
                            className="h-6 w-6 grid place-items-center rounded text-[#94A3B8] hover:text-[#DC2626] hover:bg-red-50">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="text-[12px] font-semibold text-[#0F172A] border-t-2 border-[#E2E8F0]">
                      <td className="py-2 pr-2">Subcontractor total</td>
                      <td className="py-2 px-1 text-right tabular-nums">{usd(totals.subSubtotal)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <button onClick={() => setSubs(prev => [...prev, emptySub()])}
                className="mt-2 h-7 px-2.5 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Add subcontractor row</button>
            </div>

            {/* OH&P + summary */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-4">
              <div className="flex flex-wrap items-end gap-4 mb-3">
                <div>
                  <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">OH&amp;P %</label>
                  <div className="relative w-28">
                    <input className={`${cell} w-full pr-6 ${ohpValid ? "" : "border-red-300"}`} type="number" step="0.1"
                      value={ohpPercentInput} placeholder="0" onChange={e => setOhpPercentInput(e.target.value)} />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-[#64748B]">%</span>
                  </div>
                </div>
                <div className="text-[12px] text-[#64748B]">
                  on {usd(totals.ohpBase)} (labor + materials) = <span className="font-semibold text-[#0F172A]">{usd(totals.ohpAmount)}</span>
                </div>
              </div>

              <div className="border-t border-[#E2E8F0] pt-3 space-y-1.5 max-w-[360px] ml-auto text-[13px]">
                <Line label="Labor" value={usd(totals.laborSubtotal)} />
                <Line label="Material / Equipment" value={usd(totals.materialsSubtotal)} />
                <Line label="OH&P" value={usd(totals.ohpAmount)} />
                <Line label="Subcontractor" value={usd(totals.subSubtotal)} />
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 bg-white border-t border-[#E2E8F0] sm:rounded-b-xl flex-shrink-0">
          <div>
            <div className="text-[11px] font-semibold text-[#64748B] uppercase">Grand total</div>
            <div className="text-[22px] font-bold tabular-nums text-[#0F172A] leading-tight">{usd(totals.grandTotal)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F4F5F7]">Cancel</button>
            <button disabled title="Cover sheet & save — next step"
              className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold opacity-50 cursor-not-allowed">
              Continue to cover sheet →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#64748B]">{label}</span>
      <span className="tabular-nums font-medium text-[#0F172A]">{value}</span>
    </div>
  )
}
