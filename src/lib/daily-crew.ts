// Server-side crew payload handling for daily reports (migration 0050).
// Shared by the collection POST and the per-report PATCH routes.

export interface CrewRowServer {
  trade: string
  count: number | null
  hours: number | null
}

/** Parse + sanitize a crew payload (array or JSON string — the offline
 *  pending-queue serializes it as a string inside its flat field bag).
 *  Returns null when there is nothing usable — callers must not write the
 *  column in that case. */
export function parseCrew(raw: unknown): CrewRowServer[] | null {
  let arr: unknown = raw
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(arr)) return null
  const rows = arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map(r => ({
      trade: typeof r.trade === "string" ? r.trade.slice(0, 120) : "",
      count: typeof r.count === "number" && Number.isFinite(r.count) && r.count >= 0 ? Math.round(r.count) : null,
      hours: typeof r.hours === "number" && Number.isFinite(r.hours) && r.hours >= 0 ? r.hours : null,
    }))
    .filter(r => r.trade !== "" || r.count != null || r.hours != null)
    .slice(0, 100)
  return rows.length ? rows : null
}

/** Derived headcount — written to manpower_count on every crew save for
 *  back-compat with the pre-crew list/PDF/export readers. */
export function crewHeadcount(crew: { count: number | null }[]): number {
  return crew.reduce((sum, r) => sum + (r.count ?? 0), 0)
}
