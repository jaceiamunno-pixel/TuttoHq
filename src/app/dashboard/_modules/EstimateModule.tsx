"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import type { Project } from "../_shared/types"
import { CSI_DIVISIONS } from "../_shared/csi"
import { SelectProjectEmptyState } from "../_shared/ui"

// ADR-015 Phase A — the estimate editor. TWO-COLUMN: left = grouped line grid,
// right = the pinned live bid stack.
//
// TRUST LAW (non-negotiable): the bid stack is read STRAIGHT from the estimate
// row's persisted totals (total_direct / total_burden / total_tax / total_fee /
// total_bond / permit_amount / total_bid / cost_per_sf). This module NEVER computes
// a bid total. Every line/param edit → save → the server runs recalculate_estimate()
// → the route returns the fresh header → we render that. The only client-side math
// here is a PER-LINE extended amount (display convenience, matches the PCO builder)
// — never a roll-up.

type Category = "labor" | "material" | "subcontractor" | "equipment" | "other"

interface Estimate {
  id: string
  project_id: string
  name: string
  status: string
  overhead_pct: number | null
  profit_pct: number | null
  fee_pct: number | null
  labor_burden_pct: number | null
  material_tax_exempt: boolean
  equip_material_tax_rate: number | null
  bond_pct: number | null
  permit_amount: number
  sqft: number | null
  total_direct: number
  total_burden: number
  total_tax: number
  total_fee: number
  total_bond: number
  total_bid: number
  cost_per_sf: number | null
  defaults_incomplete: boolean
  updated_at: string
}

interface EstimateLine {
  id: string
  estimate_id: string
  cost_code: string | null
  spec_number: string | null
  spec_section_id: string | null
  source: string
  description: string | null
  category: Category
  qty_reg: number | null; rate_reg: number | null
  qty_ot: number | null; rate_ot: number | null
  qty_dt: number | null; rate_dt: number | null
  material_qty: number | null; material_unit: string | null; material_unit_price: number | null
  amount: number | null
  sort_order: number
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const pctLabel = (frac: number | null | undefined) =>
  frac === null || frac === undefined ? "—" : `${+(frac * 100).toFixed(4)}%`

const parseNum = (s: string): number | null => (s.trim() === "" ? null : Number(s))
const numStr = (n: number | null): string => (n === null || n === undefined ? "" : String(n))

const CATEGORIES: Category[] = ["labor", "material", "subcontractor", "equipment", "other"]
const CSI_NAME: Record<string, string> = Object.fromEntries(CSI_DIVISIONS.map(d => [d.num, d.name]))

// PER-LINE extended amount — DISPLAY ONLY. Mirrors exactly what recalculate_estimate()
// sums per category, so the on-screen line total matches the server's contribution.
function lineExtended(l: EstimateLine): number {
  if (l.category === "labor")
    return (l.qty_reg ?? 0) * (l.rate_reg ?? 0) + (l.qty_ot ?? 0) * (l.rate_ot ?? 0) + (l.qty_dt ?? 0) * (l.rate_dt ?? 0)
  if (l.category === "material") return (l.material_qty ?? 0) * (l.material_unit_price ?? 0)
  return l.amount ?? 0 // subcontractor / equipment / other
}

function divisionOf(l: EstimateLine): string {
  if (l.source === "gc_template") return "GC"
  const s = (l.spec_number || l.cost_code || "").trim()
  const m = s.match(/(\d{2})/)
  return m ? m[1] : "—"
}
function divisionLabel(key: string): string {
  if (key === "GC") return "General Conditions"
  if (key === "—") return "Uncoded"
  return CSI_NAME[key] ? `${key} — ${CSI_NAME[key]}` : `Division ${key}`
}

export default function EstimateModule({ globalProjectId, appProjects }: {
  globalProjectId: string
  appProjects: Project[]
}) {
  const project = appProjects.find(p => p.id === globalProjectId)
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const loadList = useCallback((pid = globalProjectId) => {
    if (!pid) { setEstimates([]); return }
    setLoadingList(true)
    fetch(`/api/estimate?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setEstimates(d.estimates ?? []))
      .catch(() => setEstimates([]))
      .finally(() => setLoadingList(false))
  }, [globalProjectId])

  useEffect(() => { setOpenId(null); loadList() }, [loadList])

  if (!globalProjectId || !project) return <SelectProjectEmptyState label="estimates" />

  if (openId) {
    return <EstimateEditor
      key={openId}
      estimateId={openId}
      project={project}
      onBack={() => { setOpenId(null); loadList() }}
    />
  }

  return (
    <EstimateList
      project={project}
      estimates={estimates}
      loading={loadingList}
      onOpen={setOpenId}
      onChanged={loadList}
    />
  )
}

/* ── LIST + GENERATE ───────────────────────────────────────────────────────── */

function EstimateList({ project, estimates, loading, onOpen, onChanged }: {
  project: Project
  estimates: Estimate[]
  loading: boolean
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const [showGen, setShowGen] = useState(false)
  const [name, setName] = useState("Estimate")
  const [sqft, setSqft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create(kind: "generate" | "blank") {
    setBusy(true); setError(null)
    try {
      const url = kind === "generate" ? "/api/estimate/generate" : "/api/estimate"
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: project.id, name: name.trim() || "Estimate", sqft: parseNum(sqft) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Could not create estimate"); return }
      setShowGen(false)
      onChanged()
      if (d.id) onOpen(d.id)
    } finally { setBusy(false) }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
      <div className="max-w-[900px] mx-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-[18px] font-bold text-[#0F172A]">Estimates</h1>
            <p className="text-[13px] text-[#64748B] mt-0.5">{project.name}</p>
          </div>
          <button onClick={() => setShowGen(true)}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">
            Generate estimate
          </button>
        </div>

        <p className="text-[12px] text-[#64748B] mb-4">
          &ldquo;Generate&rdquo; scaffolds one line per in-scope spec section plus your{" "}
          <Link href="/settings?tab=labor" className="text-[#7B9BB5] underline">GC template</Link>, snapshotting your{" "}
          <Link href="/settings?tab=labor" className="text-[#7B9BB5] underline">bid defaults</Link>.
        </p>

        {loading ? (
          <div className="text-[13px] text-[#64748B] py-10 text-center">Loading…</div>
        ) : estimates.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E2E8F0] p-10 text-center">
            <p className="text-[14px] font-semibold text-[#0F172A]">No estimates yet</p>
            <p className="text-[13px] text-[#64748B] mt-1">Generate one from the project&apos;s spec scope to draft the bid.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold text-[#64748B] text-left border-b border-[#E2E8F0]">
                  <th className="py-2.5 px-4">Name</th>
                  <th className="py-2.5 px-4 w-[90px]">Status</th>
                  <th className="py-2.5 px-4 w-[140px] text-right">Total bid</th>
                  <th className="py-2.5 px-4 w-[100px] text-right">$/SF</th>
                  <th className="py-2.5 px-4 w-[110px]" />
                </tr>
              </thead>
              <tbody>
                {estimates.map(e => (
                  <tr key={e.id} className="border-b border-[#F1F5F9] last:border-0 hover:bg-[#F8FAFC] cursor-pointer" onClick={() => onOpen(e.id)}>
                    <td className="py-3 px-4 font-medium text-[#0F172A]">
                      {e.name}
                      {e.defaults_incomplete && <span className="ml-2 text-[10px] font-semibold text-amber-600 uppercase tracking-wide">defaults incomplete</span>}
                    </td>
                    <td className="py-3 px-4 text-[#64748B] capitalize">{e.status}</td>
                    <td className="py-3 px-4 text-right tabular-nums font-semibold text-[#0F172A]">{usd(e.total_bid)}</td>
                    <td className="py-3 px-4 text-right tabular-nums text-[#64748B]">{e.cost_per_sf === null ? "—" : usd(e.cost_per_sf)}</td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-[12px] font-semibold text-[#7B9BB5]">Open →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showGen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && setShowGen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-[440px] p-5" onClick={e => e.stopPropagation()}>
            <h2 className="text-[15px] font-bold text-[#0F172A] mb-3">New estimate</h2>
            <label className="block text-[12px] font-medium text-[#0F172A] mb-1">Name</label>
            <input className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] mb-3 focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
              value={name} onChange={e => setName(e.target.value)} placeholder="Estimate" />
            <label className="block text-[12px] font-medium text-[#0F172A] mb-1">Building area (SF) <span className="text-[#94A3B8] font-normal">— optional, for $/SF</span></label>
            <input className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] mb-4 focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
              type="number" step="1" value={sqft} onChange={e => setSqft(e.target.value)} placeholder="e.g. 24000" />
            {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600 mb-3">{error}</div>}
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => create("blank")} disabled={busy}
                className="h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F4F5F7] disabled:opacity-50">
                Blank
              </button>
              <button onClick={() => create("generate")} disabled={busy}
                className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
                {busy ? "Working…" : "Generate from spec"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── EDITOR ────────────────────────────────────────────────────────────────── */

function EstimateEditor({ estimateId, project, onBack }: {
  estimateId: string
  project: Project
  onBack: () => void
}) {
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [lines, setLines] = useState<EstimateLine[]>([])
  const [costCodes, setCostCodes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [savingLine, setSavingLine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/estimate/${estimateId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/estimate/cost-codes`).then(r => r.json()).catch(() => ({ cost_codes: [] })),
    ]).then(([d, cc]) => {
      if (cancelled) return
      if (d?.estimate) { setEstimate(d.estimate); setLines(d.lines ?? []) }
      setCostCodes(cc?.cost_codes ?? [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [estimateId])

  // Apply a header returned by the server (the ONLY way the bid stack changes).
  const applyEstimate = useCallback((e: Estimate | null) => { if (e) setEstimate(e) }, [])

  function setLineField(id: string, patch: Partial<EstimateLine>) {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)))
  }

  async function saveLine(line: EstimateLine) {
    setSavingLine(line.id)
    try {
      const payload = {
        cost_code: line.cost_code, spec_number: line.spec_number, description: line.description, category: line.category,
        qty_reg: line.qty_reg, rate_reg: line.rate_reg, qty_ot: line.qty_ot, rate_ot: line.rate_ot, qty_dt: line.qty_dt, rate_dt: line.rate_dt,
        material_qty: line.material_qty, material_unit: line.material_unit, material_unit_price: line.material_unit_price,
        amount: line.amount,
      }
      const res = await fetch(`/api/estimate/${estimateId}/lines/${line.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Save failed"); return }
      applyEstimate(d.estimate)
      setError(null)
    } finally { setSavingLine(null) }
  }

  async function addLine(base?: Partial<EstimateLine>) {
    const maxOrder = lines.reduce((m, l) => Math.max(m, l.sort_order), -1)
    const body = {
      category: base?.category ?? "other",
      source: base?.source ?? "manual",
      cost_code: base?.cost_code ?? null,
      spec_number: base?.spec_number ?? null,
      description: base?.description ?? null,
      qty_reg: base?.qty_reg ?? null, rate_reg: base?.rate_reg ?? null,
      qty_ot: base?.qty_ot ?? null, rate_ot: base?.rate_ot ?? null,
      qty_dt: base?.qty_dt ?? null, rate_dt: base?.rate_dt ?? null,
      material_qty: base?.material_qty ?? null, material_unit: base?.material_unit ?? null, material_unit_price: base?.material_unit_price ?? null,
      amount: base?.amount ?? null,
      sort_order: maxOrder + 1,
    }
    const res = await fetch(`/api/estimate/${estimateId}/lines`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d.error ?? "Could not add line"); return }
    setLines(prev => [...prev, d.line])
    applyEstimate(d.estimate)
  }

  async function deleteLine(id: string) {
    const res = await fetch(`/api/estimate/${estimateId}/lines/${id}`, { method: "DELETE" })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d.error ?? "Could not delete line"); return }
    setLines(prev => prev.filter(l => l.id !== id))
    applyEstimate(d.estimate)
  }

  function duplicateLine(l: EstimateLine) {
    // "Split" = duplicate the line so the estimator can break one scope into two
    // priced lines (ADR-015 merge/split ops; merge deferred pending Jace's UX call).
    addLine({ ...l, source: "manual" })
  }

  // Reorder: swap two lines' sort_order (optimistic locally; each PATCH reprices
  // but order is total-invariant, so the returned header is unchanged).
  async function swapOrder(a: EstimateLine, b: EstimateLine) {
    setLines(prev => prev.map(l =>
      l.id === a.id ? { ...l, sort_order: b.sort_order }
        : l.id === b.id ? { ...l, sort_order: a.sort_order } : l))
    await fetch(`/api/estimate/${estimateId}/lines/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: b.sort_order }) })
    await fetch(`/api/estimate/${estimateId}/lines/${b.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: a.sort_order }) })
  }

  const grouped = useMemo(() => {
    const map = new Map<string, EstimateLine[]>()
    for (const l of [...lines].sort((a, b) => a.sort_order - b.sort_order)) {
      const k = divisionOf(l)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(l)
    }
    // Order groups by the earliest sort_order they contain (preserves scaffold order).
    return [...map.entries()].sort((a, b) => a[1][0].sort_order - b[1][0].sort_order)
  }, [lines])

  if (loading) return <div className="flex-1 grid place-items-center text-[13px] text-[#64748B]">Loading estimate…</div>
  if (!estimate) return (
    <div className="flex-1 grid place-items-center text-[13px] text-[#64748B]">
      Estimate not found. <button onClick={onBack} className="ml-2 text-[#7B9BB5] underline">Back</button>
    </div>
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Editor header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-[#E2E8F0] bg-white flex-shrink-0">
        <button onClick={onBack} className="h-8 px-2.5 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F4F5F7]">← Estimates</button>
        <input
          className="flex-1 h-9 px-3 rounded-md border border-transparent hover:border-[#E2E8F0] focus:border-[#7B9BB5] text-[15px] font-bold text-[#0F172A] focus:outline-none"
          value={estimate.name}
          onChange={e => setEstimate({ ...estimate, name: e.target.value })}
          onBlur={() => patchHeader({ name: estimate.name })}
        />
        <select
          className="h-9 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] capitalize focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
          value={estimate.status}
          onChange={e => { const status = e.target.value; setEstimate({ ...estimate, status }); patchHeader({ status }) }}
        >
          <option value="draft">draft</option>
          <option value="finalized">finalized</option>
        </select>
      </div>

      {estimate.defaults_incomplete && (
        <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2 flex-shrink-0">
          <span className="text-[12px] text-amber-700 font-medium">
            Defaults incomplete — labor burden, fee, or bond isn&apos;t set, so this total is a draft.
          </span>
          <Link href="/settings?tab=labor" className="text-[12px] text-amber-800 underline font-semibold">Set bid defaults</Link>
        </div>
      )}
      {error && (
        <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-[12px] text-red-600 flex-shrink-0">{error}</div>
      )}

      {/* Two columns */}
      <div className="flex-1 min-h-0 flex">
        {/* LEFT — grouped line grid */}
        <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4 space-y-4">
          {grouped.length === 0 && (
            <div className="text-[13px] text-[#64748B] py-8 text-center">No lines yet. Add one below.</div>
          )}
          {grouped.map(([key, groupLines]) => {
            const isCollapsed = collapsed.has(key)
            return (
              <div key={key} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                <button
                  onClick={() => setCollapsed(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })}
                  className="w-full flex items-center justify-between px-4 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] hover:bg-[#F1F5F9]"
                >
                  <span className="flex items-center gap-2 text-[12px] font-bold text-[#0F172A] uppercase tracking-wide">
                    <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▸</span>
                    {divisionLabel(key)}
                    <span className="text-[11px] font-normal text-[#94A3B8] normal-case">({groupLines.length})</span>
                  </span>
                  <span className="text-[12px] tabular-nums font-semibold text-[#64748B]">
                    {usd(groupLines.reduce((s, l) => s + lineExtended(l), 0))}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="divide-y divide-[#F1F5F9]">
                    {groupLines.map((l, i) => (
                      <LineRow
                        key={l.id}
                        line={l}
                        saving={savingLine === l.id}
                        onField={(patch, save) => { setLineField(l.id, patch); if (save) saveLine({ ...l, ...patch }) }}
                        onBlur={() => saveLine(l)}
                        onDelete={() => deleteLine(l.id)}
                        onDuplicate={() => duplicateLine(l)}
                        onMoveUp={i > 0 ? () => swapOrder(l, groupLines[i - 1]) : undefined}
                        onMoveDown={i < groupLines.length - 1 ? () => swapOrder(l, groupLines[i + 1]) : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          <datalist id="estimate-cost-codes">
            {costCodes.map(c => <option key={c} value={c} />)}
          </datalist>

          <div className="flex items-center gap-2">
            <button onClick={() => addLine({ category: "other" })}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Add line</button>
            <button onClick={() => addLine({ category: "labor" })}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Labor</button>
            <button onClick={() => addLine({ category: "material" })}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Material</button>
            <button onClick={() => addLine({ category: "subcontractor" })}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">+ Sub</button>
          </div>
        </div>

        {/* RIGHT — pinned live bid stack (read from persisted totals) */}
        <BidStack
          estimate={estimate}
          project={project}
          onPatch={patchHeader}
        />
      </div>
    </div>
  )

  // Header/param edit → server recalc → apply returned totals. Percent inputs are
  // sent as fractions (÷100 in BidStack), matching the PCO builder convention.
  async function patchHeader(patch: Record<string, unknown>) {
    const res = await fetch(`/api/estimate/${estimateId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d.error ?? "Could not save"); return }
    applyEstimate(d.estimate)
    setError(null)
  }
}

/* ── LINE ROW ──────────────────────────────────────────────────────────────── */

function LineRow({ line, saving, onField, onBlur, onDelete, onDuplicate, onMoveUp, onMoveDown }: {
  line: EstimateLine
  saving: boolean
  onField: (patch: Partial<EstimateLine>, saveNow?: boolean) => void
  onBlur: () => void
  onDelete: () => void
  onDuplicate: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const cell = "h-8 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
  const numCell = `${cell} text-right tabular-nums`

  return (
    <div className="px-4 py-2 flex items-start gap-2">
      <input
        className={`${cell} w-[92px]`} list="estimate-cost-codes" placeholder="code"
        value={line.cost_code ?? ""}
        onChange={e => onField({ cost_code: e.target.value || null })}
        onBlur={onBlur}
        title="Cost code (freeform + autocomplete)"
      />
      <div className="flex-1 min-w-0">
        <input
          className={`${cell} w-full`} placeholder="Description"
          value={line.description ?? ""}
          onChange={e => onField({ description: e.target.value || null })}
          onBlur={onBlur}
        />
        {line.spec_number && (
          <span className="inline-block mt-0.5 text-[10px] text-[#94A3B8]">spec {line.spec_number}</span>
        )}
      </div>
      <select
        className={`${cell} w-[112px]`} value={line.category}
        onChange={e => onField({ category: e.target.value as Category }, true)}
        title="Category — drives which cost fields apply"
      >
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      {/* category-specific inputs */}
      <div className="w-[340px] flex items-center gap-1">
        {line.category === "labor" ? (
          <>
            {([["qty_reg", "R hr"], ["rate_reg", "R $"], ["qty_ot", "OT hr"], ["rate_ot", "OT $"], ["qty_dt", "DT hr"], ["rate_dt", "DT $"]] as const).map(([f, ph]) => (
              <input key={f} className={`${numCell} w-full min-w-0`} type="number" step="0.01" placeholder={ph}
                value={numStr(line[f])} onChange={e => onField({ [f]: parseNum(e.target.value) } as Partial<EstimateLine>)} onBlur={onBlur} />
            ))}
          </>
        ) : line.category === "material" ? (
          <>
            <input className={`${numCell} w-[90px]`} type="number" step="0.0001" placeholder="qty"
              value={numStr(line.material_qty)} onChange={e => onField({ material_qty: parseNum(e.target.value) })} onBlur={onBlur} />
            <input className={`${cell} w-[70px]`} placeholder="unit"
              value={line.material_unit ?? ""} onChange={e => onField({ material_unit: e.target.value || null })} onBlur={onBlur} />
            <input className={`${numCell} w-full min-w-0`} type="number" step="0.01" placeholder="unit $"
              value={numStr(line.material_unit_price)} onChange={e => onField({ material_unit_price: parseNum(e.target.value) })} onBlur={onBlur} />
          </>
        ) : (
          <input className={`${numCell} w-full`} type="number" step="0.01" placeholder="amount"
            value={numStr(line.amount)} onChange={e => onField({ amount: parseNum(e.target.value) })} onBlur={onBlur} />
        )}
      </div>

      <div className="w-[92px] text-right tabular-nums text-[13px] font-semibold text-[#0F172A] pt-1.5">{usd(lineExtended(line))}</div>

      <div className="flex items-center gap-0.5 pt-0.5">
        <span className={`w-3 text-[10px] ${saving ? "text-[#7B9BB5]" : "text-transparent"}`}>•</span>
        <div className="flex flex-col -space-y-1">
          <button onClick={onMoveUp} disabled={!onMoveUp} title="Move up"
            className="h-3.5 w-5 grid place-items-center rounded text-[10px] text-[#94A3B8] hover:text-[#0F172A] disabled:opacity-25 disabled:hover:text-[#94A3B8]">▲</button>
          <button onClick={onMoveDown} disabled={!onMoveDown} title="Move down"
            className="h-3.5 w-5 grid place-items-center rounded text-[10px] text-[#94A3B8] hover:text-[#0F172A] disabled:opacity-25 disabled:hover:text-[#94A3B8]">▼</button>
        </div>
        <button onClick={onDuplicate} title="Split (duplicate line)"
          className="h-7 w-7 grid place-items-center rounded text-[#94A3B8] hover:text-[#7B9BB5] hover:bg-[#F1F5F9]">⎘</button>
        <button onClick={onDelete} title="Delete line"
          className="h-7 w-7 grid place-items-center rounded text-[#94A3B8] hover:text-[#DC2626] hover:bg-red-50">×</button>
      </div>
    </div>
  )
}

/* ── BID STACK (right rail) ────────────────────────────────────────────────── */

function BidStack({ estimate, project, onPatch }: {
  estimate: Estimate
  project: Project
  onPatch: (patch: Record<string, unknown>) => void
}) {
  // Local editable copies of the param inputs (percents shown, fractions sent).
  const [feePct, setFeePct] = useState("")
  const [burdenPct, setBurdenPct] = useState("")
  const [bondPct, setBondPct] = useState("")
  const [taxRate, setTaxRate] = useState("")
  const [permit, setPermit] = useState("")
  const [sqft, setSqft] = useState("")
  const [taxExempt, setTaxExempt] = useState(true)

  useEffect(() => {
    setFeePct(estimate.fee_pct === null ? "" : String(+(estimate.fee_pct * 100).toFixed(4)))
    setBurdenPct(estimate.labor_burden_pct === null ? "" : String(+(estimate.labor_burden_pct * 100).toFixed(4)))
    setBondPct(estimate.bond_pct === null ? "" : String(+(estimate.bond_pct * 100).toFixed(4)))
    setTaxRate(estimate.equip_material_tax_rate === null ? "" : String(+(estimate.equip_material_tax_rate * 100).toFixed(4)))
    setPermit(estimate.permit_amount ? String(estimate.permit_amount) : "")
    setSqft(estimate.sqft === null ? "" : String(estimate.sqft))
    setTaxExempt(estimate.material_tax_exempt)
    // Sync only when a fresh header arrives (id or the persisted values change).
  }, [estimate.id, estimate.fee_pct, estimate.labor_burden_pct, estimate.bond_pct, estimate.equip_material_tax_rate, estimate.permit_amount, estimate.sqft, estimate.material_tax_exempt])

  const frac = (s: string): number | null => (s.trim() === "" ? null : Number(s) / 100)
  const money = (s: string): number => (s.trim() === "" ? 0 : Number(s))
  const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s))

  const paramCls = "h-8 w-24 pr-6 pl-2 rounded-md border border-[#E2E8F0] text-[13px] text-right tabular-nums text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"

  // A stack row. `value` is a persisted total → rendered verbatim (never summed).
  const Row = ({ label, value, strong, note }: { label: string; value: string; strong?: boolean; note?: string }) => (
    <div className={`flex items-center justify-between ${strong ? "pt-2 mt-1 border-t border-[#E2E8F0]" : ""}`}>
      <span className={`text-[12px] ${strong ? "font-bold text-[#0F172A]" : "text-[#64748B]"}`}>{label}{note && <span className="text-[10px] text-[#94A3B8] ml-1">{note}</span>}</span>
      <span className={`tabular-nums ${strong ? "text-[16px] font-bold text-[#0F172A]" : "text-[13px] font-medium text-[#0F172A]"}`}>{value}</span>
    </div>
  )

  return (
    <div className="w-[340px] flex-shrink-0 border-l border-[#E2E8F0] bg-white overflow-y-auto">
      <div className="p-5 space-y-4">
        <div>
          <h3 className="text-[12px] font-bold text-[#0F172A] uppercase tracking-wide mb-3">Bid stack</h3>
          <div className="space-y-1.5">
            <Row label="Direct cost" value={usd(estimate.total_direct)} />
            <Row label="Labor burden" value={usd(estimate.total_burden)} note={pctLabel(estimate.labor_burden_pct)} />
            <Row label="Sales tax" value={usd(estimate.total_tax)} note={estimate.material_tax_exempt ? "exempt" : pctLabel(estimate.equip_material_tax_rate)} />
            <Row label="Fee (OH+profit)" value={usd(estimate.total_fee)} note={pctLabel(estimate.fee_pct)} />
            <Row label="Bond" value={usd(estimate.total_bond)} note={pctLabel(estimate.bond_pct)} />
            <Row label="Permit" value={usd(estimate.permit_amount)} />
            <Row label="Total bid" value={usd(estimate.total_bid)} strong />
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-[#94A3B8]">Cost / SF</span>
              <span className="text-[12px] tabular-nums text-[#64748B]">{estimate.cost_per_sf === null ? "—" : usd(estimate.cost_per_sf)}</span>
            </div>
          </div>
          <p className="text-[10px] text-[#94A3B8] mt-3 leading-snug">
            Every figure is the server&apos;s persisted total from recalculate_estimate(). Edits below save, reprice, and re-read.
          </p>
        </div>

        {/* Params — edits PATCH the header, server reprices */}
        <div className="border-t border-[#E2E8F0] pt-4 space-y-2.5">
          <h4 className="text-[11px] font-bold text-[#64748B] uppercase tracking-wide">Bid parameters</h4>

          <Param label="Fee (OH + profit)" suffix="%">
            <input className={paramCls} type="number" step="0.01" value={feePct}
              onChange={e => setFeePct(e.target.value)} onBlur={() => onPatch({ fee_pct: frac(feePct) })} />
          </Param>
          <Param label="Labor burden" suffix="%" hint={estimate.labor_burden_pct === null ? "not set" : undefined}>
            <input className={paramCls} type="number" step="0.01" value={burdenPct}
              onChange={e => setBurdenPct(e.target.value)} onBlur={() => onPatch({ labor_burden_pct: frac(burdenPct) })} />
          </Param>
          <Param label="Bond" suffix="%" hint={estimate.bond_pct === null ? "not set" : undefined}>
            <input className={paramCls} type="number" step="0.01" value={bondPct}
              onChange={e => setBondPct(e.target.value)} onBlur={() => onPatch({ bond_pct: frac(bondPct) })} />
          </Param>

          <label className="flex items-center gap-2 pt-1">
            <input type="checkbox" checked={taxExempt}
              onChange={e => { setTaxExempt(e.target.checked); onPatch({ material_tax_exempt: e.target.checked }) }}
              className="h-4 w-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]" />
            <span className="text-[12px] text-[#0F172A]">Material tax-exempt</span>
          </label>
          {!taxExempt && (
            <Param label="Tax rate" suffix="%" hint={estimate.equip_material_tax_rate === null ? "not set" : undefined}>
              <input className={paramCls} type="number" step="0.01" value={taxRate}
                onChange={e => setTaxRate(e.target.value)} onBlur={() => onPatch({ equip_material_tax_rate: frac(taxRate) })} />
            </Param>
          )}

          <Param label="Permit" suffix="$">
            <input className={paramCls} type="number" step="0.01" value={permit}
              onChange={e => setPermit(e.target.value)} onBlur={() => onPatch({ permit_amount: money(permit) })} />
          </Param>
          <Param label="Area (SF)" suffix="">
            <input className={paramCls} type="number" step="1" value={sqft}
              onChange={e => setSqft(e.target.value)} onBlur={() => onPatch({ sqft: numOrNull(sqft) })} />
          </Param>
          <p className="text-[10px] text-[#94A3B8] pt-1">Snapshotted from company bid defaults for {project.name}; edits here affect only this estimate.</p>
        </div>
      </div>
    </div>
  )
}

function Param({ label, suffix, hint, children }: { label: string; suffix: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-[#0F172A]">{label}{hint && <span className="text-[10px] text-amber-600 ml-1">{hint}</span>}</span>
      <div className="relative">
        {children}
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-[#64748B] pointer-events-none">{suffix}</span>}
      </div>
    </div>
  )
}
