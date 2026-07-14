// RFI numbering — per-project, MAX-over-ALL-rows + 1 (including soft-deleted),
// so a deleted RFI-004 leaves a PERMANENT gap and its number is never recycled.
// Mirrors src/lib/pco-number.ts. The authoritative derivation runs in the create
// route (POST /api/rfis) with a bounded retry on the partial-unique collision
// (uq_rfis_project_number, 0044) — two browsers creating at once still land
// distinct numbers because the losing insert re-reads the committed MAX.
//
// Numbers are stored as "RFI-NNN"; only that exact shape counts toward the
// sequence. Any other value (legacy/custom) parses to null and is ignored — the
// route only ever writes "RFI-NNN", so this is purely defensive.

export function parseRfiNumber(rfi: string | null | undefined): number | null {
  if (rfi == null) return null
  const m = String(rfi).trim().match(/^RFI-(\d+)$/)
  return m ? parseInt(m[1], 10) : null
}

export function formatRfiNumber(n: number): string {
  return `RFI-${String(n).padStart(3, "0")}`
}

export function nextRfiNumber(rfiNumbers: (string | null | undefined)[]): { next: number; display: string } {
  const max = rfiNumbers.reduce<number>((mx, r) => {
    const n = parseRfiNumber(r)
    return n != null && n > mx ? n : mx
  }, 0)
  const next = max + 1
  return { next, display: formatRfiNumber(next) }
}
