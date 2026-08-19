import type { SupabaseClient } from "@supabase/supabase-js"
import { parseCoNumber } from "@/lib/pco-number"

// Shared server-side helpers for the sub-change-orders routes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

/** Parse a money-ish input ("$12,500.00") to a finite number.
 *  undefined = field absent; null = explicit empty; NaN never escapes —
 *  an unparseable value returns undefined AND sets `invalid`. */
export function parseMoney(v: unknown): { value: number | null | undefined; invalid: boolean } {
  if (v === undefined) return { value: undefined, invalid: false }
  if (v === null) return { value: null, invalid: false }
  const s = String(v).replace(/[$,\s]/g, "")
  if (s === "") return { value: null, invalid: false }
  const n = Number(s)
  return Number.isFinite(n) ? { value: n, invalid: false } : { value: undefined, invalid: true }
}

/** Next default co_number for (project, vendor): MAX(numeric co_number)+1 over
 *  ALL rows including soft-deleted ones, so a retired number leaves a permanent
 *  gap and is never reused (the 0045a change_orders precedent). */
export async function deriveNextSubCoNumber(
  supabase: AnyClient,
  projectId: string,
  vendorId: string,
): Promise<string> {
  const { data } = await supabase
    .from("sub_change_orders")
    .select("co_number")
    .eq("project_id", projectId)
    .eq("vendor_id", vendorId)
  const max = ((data ?? []) as { co_number: string | null }[]).reduce<number>((mx, r) => {
    const n = parseCoNumber(r.co_number)
    return n != null && n > mx ? n : mx
  }, 0)
  return String(max + 1)
}

/** Sum line prices to cents-rounded totals. */
export function sumLinePrices(lines: { price: number | null }[]): number {
  return Math.round(lines.reduce((s, l) => s + (l.price ?? 0), 0) * 100) / 100
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The six numbers printed in the CO form's right-hand recap column.
 *  `computed*` is always the derived value; `previous*` is what actually
 *  prints (override when set). Callers must never recompute any of these. */
export type SubCoRecap = {
  originalContractAmount: number
  computedPreviousAdditions: number
  computedPreviousDeductions: number
  previousAdditions: number
  previousDeductions: number
  previousAdditionsIsOverride: boolean
  previousDeductionsIsOverride: boolean
  thisOrder: number
  previousTotal: number
  presentContractAmount: number
}

/** Row shape computeSubCoRecap needs. `select("*")` satisfies it. */
export type SubCoRecapInput = {
  id: string
  project_id: string | null
  vendor_id: string
  created_at: string
  original_contract_amount: number | null
  prior_additions_override?: number | null
  prior_deductions_override?: number | null
}

/** THE single producer of the CO recap. Both the PDF route and the editor
 *  preview endpoint call this, so the page and the preview can never disagree.
 *
 *  previous additions/deductions are DERIVED from earlier COs for the same
 *  (project, vendor) — status in (sent, accepted), created_at < this one.
 *  A per-CO total > 0 is an addition, < 0 an (abs) deduction. When the
 *  subcontract's history predates TuttoHQ there are no such rows, so the user
 *  can override either magnitude; `??` means an explicit 0 override still wins
 *  over the derived sum. */
export async function computeSubCoRecap(
  supabase: AnyClient,
  sco: SubCoRecapInput,
): Promise<SubCoRecap> {
  const { data: linesRaw } = await supabase
    .from("sub_change_order_lines")
    .select("price")
    .eq("sub_change_order_id", sco.id)
  const thisOrder = sumLinePrices((linesRaw ?? []) as { price: number | null }[])

  const { data: priorScos } = await supabase
    .from("sub_change_orders")
    .select("id")
    .eq("project_id", sco.project_id)
    .eq("vendor_id", sco.vendor_id)
    .in("status", ["sent", "accepted"])
    .lt("created_at", sco.created_at)
    .neq("id", sco.id)
  let computedPreviousAdditions = 0
  let computedPreviousDeductions = 0
  const priorIds = ((priorScos ?? []) as { id: string }[]).map(r => r.id)
  if (priorIds.length) {
    const { data: priorLines } = await supabase
      .from("sub_change_order_lines")
      .select("sub_change_order_id, price")
      .in("sub_change_order_id", priorIds)
    const totals = new Map<string, number>()
    for (const l of (priorLines ?? []) as { sub_change_order_id: string; price: number | null }[]) {
      totals.set(l.sub_change_order_id, (totals.get(l.sub_change_order_id) ?? 0) + (l.price ?? 0))
    }
    for (const pid of priorIds) {
      const t = round2(totals.get(pid) ?? 0)
      if (t > 0) computedPreviousAdditions += t
      else if (t < 0) computedPreviousDeductions += Math.abs(t)
    }
    computedPreviousAdditions = round2(computedPreviousAdditions)
    computedPreviousDeductions = round2(computedPreviousDeductions)
  }

  const addOverride = sco.prior_additions_override
  const dedOverride = sco.prior_deductions_override
  const previousAdditions = addOverride ?? computedPreviousAdditions
  const previousDeductions = dedOverride ?? computedPreviousDeductions

  const originalContractAmount = sco.original_contract_amount ?? 0
  const previousTotal = round2(originalContractAmount + previousAdditions - previousDeductions)
  const presentContractAmount = round2(previousTotal + thisOrder)

  return {
    originalContractAmount,
    computedPreviousAdditions,
    computedPreviousDeductions,
    previousAdditions,
    previousDeductions,
    previousAdditionsIsOverride: addOverride != null,
    previousDeductionsIsOverride: dedOverride != null,
    thisOrder,
    previousTotal,
    presentContractAmount,
  }
}
