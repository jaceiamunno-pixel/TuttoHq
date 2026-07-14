// Plain (non-builder) change order numbering — per-project, MAX-over-ALL-rows + 1
// (including soft-deleted), so a deleted CO-004 leaves a PERMANENT gap and its
// number is never recycled. Mirrors src/lib/pco-number.ts, which handles the
// SEPARATE builder pure-digit sequence (has_pco_detail = true).
//
// Used only as the fallback when the user leaves the CO number blank; a
// user-typed number always wins (and is duplicate-checked by the partial unique
// index uq_change_orders_project_plain_number, 0046). The bounded retry lives in
// the create route (POST /api/change-orders).
//
// Numbers are stored as "CO-NNN"; only that exact shape counts toward the plain
// sequence. A builder pure-digit "004" or any custom value parses to null and is
// ignored, so plain and builder numbering stay independent within the shared
// co_number column.

export function parsePlainCoNumber(co: string | null | undefined): number | null {
  if (co == null) return null
  const m = String(co).trim().match(/^CO-(\d+)$/)
  return m ? parseInt(m[1], 10) : null
}

export function formatPlainCoNumber(n: number): string {
  return `CO-${String(n).padStart(3, "0")}`
}

export function nextPlainCoNumber(coNumbers: (string | null | undefined)[]): { next: number; display: string } {
  const max = coNumbers.reduce<number>((mx, c) => {
    const n = parsePlainCoNumber(c)
    return n != null && n > mx ? n : mx
  }, 0)
  const next = max + 1
  return { next, display: formatPlainCoNumber(next) }
}
