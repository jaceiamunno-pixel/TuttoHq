// PCO numbering — the careful bit. The next PCO number for a project is
// (max numeric co_number in that project) + 1, parsing the numeric portion of
// each co_number and ignoring any value with no parseable number (legacy/non-
// numeric rows). This is intentionally MAX-based, not a row COUNT: a deleted PCO
// must not cause a new one to collide with an existing number.
//
// Shared by the display-only preview endpoint and (Phase 3) the authoritative
// re-derivation inside the INSERT, so two browsers opening the builder at once
// still land distinct numbers — the insert recomputes from the live table.

export function parseCoNumber(co: string | null | undefined): number | null {
  if (co == null) return null
  const m = String(co).match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

export function formatPcoNumber(n: number): string {
  return String(n).padStart(3, "0")
}

export function nextPcoNumber(coNumbers: (string | null | undefined)[]): { next: number; display: string } {
  const max = coNumbers.reduce<number>((mx, c) => {
    const n = parseCoNumber(c)
    return n != null && n > mx ? n : mx
  }, 0)
  const next = max + 1
  return { next, display: formatPcoNumber(next) }
}
