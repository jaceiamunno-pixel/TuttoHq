// Shared validation for labor-rate fields, imported by the /api/labor-rates
// routes. Lives in lib (not the route file) because Next.js route modules may
// only export recognized HTTP handlers.

// A rate may be null (unset) or a non-negative number. Returns:
//   undefined → the value was present but invalid (negative / non-numeric)
//   null      → explicitly cleared ("" or null)
//   number    → a valid non-negative rate
export function parseRate(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}
