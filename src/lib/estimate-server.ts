import { createClient } from "@/lib/supabase/server"

// ADR-015 Phase A — server-side estimate helpers. This module is the CAREFUL-LANE
// money chokepoint.
//
// TRUST LAW (non-negotiable, ADR-015): the ONLY producer of estimate totals is the
// server-side recalculate_estimate() SECURITY DEFINER function. No total is ever
// computed in app code — every mutation route writes lines/params, then calls
// recalcAndRead() so the persisted snapshot is recomputed and re-read. The client
// only ever DISPLAYS the persisted totals it reads back.
//
// LINKAGE LAW (non-negotiable, ADR-015): spec linkage is by spec_number TEXT.
// spec_section_id is nullable/decorative (ON DELETE SET NULL) and never relied on
// for correctness — a re-parse that nulls it must not change a bid.

type ServerClient = Awaited<ReturnType<typeof createClient>>

// Full estimate header (all persisted totals). Re-read verbatim after every recalc
// so the client's bid stack is always the server's snapshot, never a local sum.
export const ESTIMATE_COLUMNS =
  "id, project_id, company_id, name, status, overhead_pct, profit_pct, labor_burden_pct, " +
  "material_tax_exempt, equip_material_tax_rate, fee_pct, bond_pct, permit_amount, sqft, " +
  "total_direct, total_burden, total_tax, total_fee, total_bond, total_bid, cost_per_sf, " +
  "defaults_incomplete, created_by, created_at, updated_at"

// Every estimate_line column the editor round-trips.
export const LINE_COLUMNS =
  "id, estimate_id, cost_code, spec_number, spec_section_id, source, description, category, " +
  "qty_reg, rate_reg, qty_ot, rate_ot, qty_dt, rate_dt, " +
  "material_qty, material_unit, material_unit_price, amount, sort_order, created_at"

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * Recalculate the estimate's persisted totals via the server-side function, then
 * re-read and return the fresh header. The SINGLE money read/write chokepoint.
 * recalculate_estimate() itself re-checks tenant ownership and raises on a
 * cross-tenant id, so this is safe to call with any caller-supplied estimate id.
 */
export async function recalcAndRead(
  supabase: ServerClient,
  estimateId: string,
): Promise<{ estimate: Record<string, unknown> | null; error: string | null }> {
  const { error: rErr } = await supabase.rpc("recalculate_estimate", { p_estimate_id: estimateId })
  if (rErr) return { estimate: null, error: rErr.message }
  const { data, error } = await supabase
    .from("estimates")
    .select(ESTIMATE_COLUMNS)
    .eq("id", estimateId)
    .single()
  if (error) return { estimate: null, error: error.message }
  return { estimate: (data as unknown as Record<string, unknown>) ?? null, error: null }
}

type DefaultsSnapshot = {
  overhead_pct: number
  profit_pct: number
  fee_pct: number
  labor_burden_pct: number | null
  material_tax_exempt: boolean
  equip_material_tax_rate: number | null
  bond_pct: number | null
}

/**
 * Snapshot the company's bid defaults into an estimate's own pct columns so a
 * later edit of company_bid_defaults never retro-alters a drafted bid.
 *
 * recalculate_estimate() reads fee_pct (the combined markup). company_bid_defaults
 * stores overhead + profit separately, so fee_pct = overhead + profit — the ADR's
 * "10-10 rule" → 0.20 baseline markup, ADDITIVE. overhead_pct/profit_pct are
 * carried as provenance only. (Additive vs compounded is the one open money
 * question for the THP penny-tie — flagged in the PR, not guessed silently.)
 *
 * GENERAL-SOFTWARE RULE: burden / tax rate / bond have no national default and
 * ship NULL; they are snapshotted as-is (null → "not set"), never coerced to 0.
 * A null in any of these is what recalculate_estimate() reports as
 * defaults_incomplete = true.
 */
export async function snapshotDefaults(supabase: ServerClient): Promise<DefaultsSnapshot> {
  const { data } = await supabase
    .from("company_bid_defaults")
    .select("overhead_pct, profit_pct, labor_burden_pct, material_tax_exempt, equip_material_tax_rate, bond_pct")
    .maybeSingle()

  const overhead = num(data?.overhead_pct) ?? 0.1
  const profit = num(data?.profit_pct) ?? 0.1
  return {
    overhead_pct: overhead,
    profit_pct: profit,
    fee_pct: round4(overhead + profit),
    labor_burden_pct: num(data?.labor_burden_pct),
    material_tax_exempt: data?.material_tax_exempt ?? true,
    equip_material_tax_rate: num(data?.equip_material_tax_rate),
    bond_pct: num(data?.bond_pct),
  }
}

type GcTemplateRow = {
  category: string | null
  default_qty: number | null
  default_unit: string | null
  default_unit_cost: number | null
}

/**
 * Map a gc_template_items row onto the estimate_line cost fields for its category.
 * For subcontractor/equipment/other the only field recalculate_estimate() reads is
 * `amount`, so the template's qty × unit_cost is collapsed into a single seed
 * INPUT (done server-side, exactly as if the estimator had typed it). This is a
 * line-input seed, NOT a bid-stack computation — the stack is still 100% recalc.
 */
export function gcLineCostFields(tpl: GcTemplateRow): Record<string, unknown> {
  const cat = tpl.category ?? "other"
  if (cat === "labor") {
    return { qty_reg: tpl.default_qty, rate_reg: tpl.default_unit_cost }
  }
  if (cat === "material") {
    return {
      material_qty: tpl.default_qty,
      material_unit: tpl.default_unit,
      material_unit_price: tpl.default_unit_cost,
    }
  }
  const cost = tpl.default_unit_cost
  const amount = cost == null ? null : round2((tpl.default_qty ?? 1) * cost)
  return { amount }
}

// Coerce a possibly-string/undefined numeric into number | null (never NaN).
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
