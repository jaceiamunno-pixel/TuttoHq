// PCO pricing math — the single source of truth shared by the builder UI, the
// save path (Phase 3), and the PDF exports (Phase 4) so on-screen totals, the
// stored pricing_sum, and the generated documents can never disagree.
//
// Mirrors THP's "SRC - THP PCO 054.xlsx" exactly:
//   Labor subtotal      = Σ (qty_reg·rate_reg + qty_ot·rate_ot + qty_dt·rate_dt)
//   Materials subtotal   = Σ (qty·unit_price)
//   Subcontractor total  = Σ amount
//   OH&P amount          = percent · (Labor subtotal + Materials subtotal)   [J40=(J38+J20)*C40]
//   GRAND TOTAL          = Labor + Materials + OH&P + Subcontractor
// OH&P is applied to labor + materials ONLY — never to subcontractor lines.
// Negative quantities/amounts are allowed (credits).

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const n0 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export interface PcoLaborLine {
  qty_reg: number | null; rate_reg: number | null
  qty_ot: number | null;  rate_ot: number | null
  qty_dt: number | null;  rate_dt: number | null
}
export interface PcoMaterialLine { qty: number | null; unit_price: number | null }
export interface PcoSubLine { amount: number | null }

export function laborLineTotal(l: PcoLaborLine): number {
  return round2(n0(l.qty_reg) * n0(l.rate_reg) + n0(l.qty_ot) * n0(l.rate_ot) + n0(l.qty_dt) * n0(l.rate_dt))
}
export function materialLineTotal(m: PcoMaterialLine): number {
  return round2(n0(m.qty) * n0(m.unit_price))
}

export interface PcoTotals {
  laborSubtotal: number
  hoursReg: number; hoursOt: number; hoursDt: number
  materialsSubtotal: number
  subSubtotal: number
  ohpBase: number   // labor + materials (the base OH&P is applied to)
  ohpAmount: number
  grandTotal: number
}

// ohpPercent is a FRACTION (0.15 == 15%), matching company_settings.default_oh_p_percent
// and change_orders.oh_p_percent.
export function computePcoTotals(
  labor: PcoLaborLine[],
  materials: PcoMaterialLine[],
  subs: PcoSubLine[],
  ohpPercent: number | null,
): PcoTotals {
  const laborSubtotal     = round2(labor.reduce((s, l) => s + laborLineTotal(l), 0))
  const hoursReg          = round2(labor.reduce((s, l) => s + n0(l.qty_reg), 0))
  const hoursOt           = round2(labor.reduce((s, l) => s + n0(l.qty_ot), 0))
  const hoursDt           = round2(labor.reduce((s, l) => s + n0(l.qty_dt), 0))
  const materialsSubtotal = round2(materials.reduce((s, m) => s + materialLineTotal(m), 0))
  const subSubtotal       = round2(subs.reduce((s, x) => s + n0(x.amount), 0))
  const ohpBase           = round2(laborSubtotal + materialsSubtotal)
  const ohpAmount         = round2(n0(ohpPercent) * ohpBase)
  const grandTotal        = round2(laborSubtotal + materialsSubtotal + ohpAmount + subSubtotal)
  return { laborSubtotal, hoursReg, hoursOt, hoursDt, materialsSubtotal, subSubtotal, ohpBase, ohpAmount, grandTotal }
}
