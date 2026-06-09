// Change-order contract math — the single source of truth shared by the CO
// module UI and the Excel export, so on-screen figures and the downloaded log
// can never diverge. Mirrors the Gilbane PCO-log spreadsheet logic exactly.

type CoMathRow = { assigned_co_number: string | null; status: string; pricing_sum: number | null }

// A C.O.# marks an EXECUTED (realized) change only when it is a plain integer —
// "1", "7", "12". Tag-style numbers like "TA-11"/"TA-12", decimals, negatives,
// or a blank/null C.O.# are NOT executed.
export function isExecutedCoNumber(assigned: string | null | undefined): boolean {
  return !!assigned && /^\d+$/.test(assigned.trim())
}

// Realized dollar value of one change order: its proposed amount when the C.O.#
// is a plain integer AND the status is not Rejected; otherwise 0. Credits
// (negative amounts) carry through unchanged.
export function realizedAmount(c: CoMathRow): number {
  if (c.status === "Rejected") return 0
  if (!isExecutedCoNumber(c.assigned_co_number)) return 0
  return c.pricing_sum ?? 0
}

// Round to cents to keep float summation from drifting (e.g. 531664.79999999).
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface CoContractTotals {
  totalProposed: number          // Σ amount over ALL COs
  sumRealized: number            // Σ realized (executed, numeric C.O.#, not rejected)
  revisedContractValue: number   // base + Σ realized
  openChanges: number            // Σ amount for proposed-but-not-executed (not rejected)
}

export function computeCoTotals(rows: CoMathRow[], base: number | null): CoContractTotals {
  const totalProposed = rows.reduce((s, c) => s + (c.pricing_sum ?? 0), 0)
  const sumRealized = rows.reduce((s, c) => s + realizedAmount(c), 0)
  // Open changes = proposed but not yet executed: a real amount on a row that is
  // neither Rejected nor carrying a numeric (executed) C.O.#.
  const openChanges = rows.reduce(
    (s, c) => (c.status !== "Rejected" && !isExecutedCoNumber(c.assigned_co_number) ? s + (c.pricing_sum ?? 0) : s),
    0,
  )
  const baseVal = base ?? 0
  return {
    totalProposed: round2(totalProposed),
    sumRealized: round2(sumRealized),
    revisedContractValue: round2(baseVal + sumRealized),
    openChanges: round2(openChanges),
  }
}
