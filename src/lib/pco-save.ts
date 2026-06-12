// Server-side PCO save helpers, shared by the create (POST) and update (PUT)
// routes so pricing_sum and the persisted line items are computed ONE way.
//
// pricing_sum is ALWAYS recomputed here via the Phase 2 single-source-of-truth
// math (computePcoTotals) — the client's grand total is never trusted. This is
// the same function the builder UI and the PDF (Phase 4) use, so the on-screen
// total, the stored pricing_sum, and the document can't drift.

import { computePcoTotals } from "@/app/dashboard/_shared/pco-math"

export interface PcoLaborInput {
  description?: string | null
  qty_reg?: number | null; rate_reg?: number | null
  qty_ot?: number | null;  rate_ot?: number | null
  qty_dt?: number | null;  rate_dt?: number | null
}
export interface PcoMaterialInput {
  description?: string | null
  qty?: number | null; unit?: string | null; unit_price?: number | null; note?: string | null
}
export interface PcoSubInput { description?: string | null; amount?: number | null }

export interface PcoSaveBody {
  labor?: PcoLaborInput[]
  materials?: PcoMaterialInput[]
  subs?: PcoSubInput[]
  oh_p_percent?: number | null // FRACTION (0.15 == 15%)
  fee_percent?: number | null  // FRACTION; % of the full pre-fee total
  textura_fee?: number | null  // flat cover Textura fee (THP import); 0 for builder PCOs
}

const arr = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : [])
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

// pricing_sum = grand total (INCLUDES fee — this is the cover total), recomputed
// from the submitted lines (never trusted from the client).
export function computePcoPricingSum(body: PcoSaveBody): number {
  return computePcoTotals(
    arr(body.labor).map(l => ({
      qty_reg: numOrNull(l.qty_reg), rate_reg: numOrNull(l.rate_reg),
      qty_ot: numOrNull(l.qty_ot),  rate_ot: numOrNull(l.rate_ot),
      qty_dt: numOrNull(l.qty_dt),  rate_dt: numOrNull(l.rate_dt),
    })),
    arr(body.materials).map(m => ({ qty: numOrNull(m.qty), unit_price: numOrNull(m.unit_price) })),
    arr(body.subs).map(s => ({ amount: numOrNull(s.amount) })),
    numOrNull(body.oh_p_percent),
    numOrNull(body.fee_percent),
    numOrNull(body.textura_fee),
  ).grandTotal
}

// A line is "blank" (dropped) when it carries no description and no numeric
// value — i.e. an untouched ad-hoc row. Seeded labor rows keep their role name,
// so they survive even at qty 0 (the backup worksheet lists every role).
function laborIsBlank(l: PcoLaborInput): boolean {
  return !txt(l.description) && [l.qty_reg, l.rate_reg, l.qty_ot, l.rate_ot, l.qty_dt, l.rate_dt].every(v => numOrNull(v) === null)
}
function materialIsBlank(m: PcoMaterialInput): boolean {
  return !txt(m.description) && !txt(m.unit) && !txt(m.note) && numOrNull(m.qty) === null && numOrNull(m.unit_price) === null
}
function subIsBlank(s: PcoSubInput): boolean {
  return !txt(s.description) && numOrNull(s.amount) === null
}

// New labor roles to add to the company rate book ("create" from the builder
// typeahead): any labor line whose role name isn't already in the book. Rates
// snapshot from the line so the role shows up pre-priced next time. Pure — the
// route fetches existing names + does the insert.
export function newLaborRoleRows(
  body: PcoSaveBody,
  existingRoleNames: string[],
): { role_name: string; reg_rate: number | null; ot_rate: number | null; dt_rate: number | null; active: boolean }[] {
  const have = new Set(existingRoleNames.map(r => r.trim().toLowerCase()))
  const seen = new Set<string>()
  const rows: { role_name: string; reg_rate: number | null; ot_rate: number | null; dt_rate: number | null; active: boolean }[] = []
  for (const l of arr(body.labor)) {
    const name = txt(l.description)
    if (!name) continue
    const key = name.toLowerCase()
    if (have.has(key) || seen.has(key)) continue
    seen.add(key)
    rows.push({ role_name: name, reg_rate: numOrNull(l.rate_reg), ot_rate: numOrNull(l.rate_ot), dt_rate: numOrNull(l.rate_dt), active: true })
  }
  return rows
}

// Build the line-item objects for one PCO, in display order. These are passed
// as a JSONB array to save_pco(), which assigns change_order_id (v_id) and the
// company_id DEFAULT under RLS — so neither is set here.
export function buildLineItemRows(body: PcoSaveBody): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  let order = 0
  for (const l of arr(body.labor)) {
    if (laborIsBlank(l)) continue
    rows.push({
      category: "labor", description: txt(l.description),
      qty_reg: numOrNull(l.qty_reg), rate_reg: numOrNull(l.rate_reg),
      qty_ot: numOrNull(l.qty_ot),  rate_ot: numOrNull(l.rate_ot),
      qty_dt: numOrNull(l.qty_dt),  rate_dt: numOrNull(l.rate_dt),
      sort_order: order++,
    })
  }
  for (const m of arr(body.materials)) {
    if (materialIsBlank(m)) continue
    rows.push({
      category: "material", description: txt(m.description),
      qty: numOrNull(m.qty), unit: txt(m.unit), unit_price: numOrNull(m.unit_price), note: txt(m.note),
      sort_order: order++,
    })
  }
  for (const s of arr(body.subs)) {
    if (subIsBlank(s)) continue
    rows.push({
      category: "subcontractor", description: txt(s.description),
      amount: numOrNull(s.amount), sort_order: order++,
    })
  }
  return rows
}
