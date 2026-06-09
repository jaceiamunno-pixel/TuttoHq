// Change-order contract math — the single source of truth shared by the CO
// module UI and the Excel export, so on-screen figures and the downloaded log
// can never diverge.
//
// REALIZED is a USER-ENTERED, STORED value (change_orders.realized_amount) — the
// dollar amount the other side actually accepted. It is NOT derived from the
// C.O.#. It is null until entered (and only enterable once a C.O.# is assigned).

type CoMathRow = { status: string; pricing_sum: number | null; realized_amount: number | null }

// Round to cents to keep float summation from drifting (e.g. 531664.79999999).
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface CoContractTotals {
  totalProposed: number          // Σ proposed amount over ALL COs
  sumRealized: number            // Σ realized_amount over non-Rejected COs (null → 0)
  revisedContractValue: number   // base + Σ realized
  openChanges: number            // Σ proposed amount where realized not entered (null) and not Rejected
}

export function computeCoTotals(rows: CoMathRow[], base: number | null): CoContractTotals {
  const totalProposed = rows.reduce((s, c) => s + (c.pricing_sum ?? 0), 0)
  // Revised: only realized (accepted) values count, on non-Rejected COs.
  // realized_amount is null until entered, so unrealized COs contribute 0.
  const sumRealized = rows.reduce(
    (s, c) => (c.status !== "Rejected" ? s + (c.realized_amount ?? 0) : s), 0)
  // Open changes: the proposed amount on COs that aren't realized yet
  // (realized_amount IS NULL) and aren't Rejected.
  const openChanges = rows.reduce(
    (s, c) => (c.status !== "Rejected" && c.realized_amount == null ? s + (c.pricing_sum ?? 0) : s), 0)
  const baseVal = base ?? 0
  return {
    totalProposed: round2(totalProposed),
    sumRealized: round2(sumRealized),
    revisedContractValue: round2(baseVal + sumRealized),
    openChanges: round2(openChanges),
  }
}
