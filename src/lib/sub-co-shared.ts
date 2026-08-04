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
