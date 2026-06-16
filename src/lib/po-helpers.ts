// Shared parsing/normalization for Purchase Order line items, used by the PO
// create (POST) and edit (PATCH) routes so they agree on validation + totals.

export interface LineInput { quantity?: unknown; description?: unknown; unit_price?: unknown }
export interface NormalizedLine { line_no: number; quantity: number | null; description: string | null; unit_price: number | null }

// Parse a money/number-ish string|number into a finite number or null.
export function num(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""))
  return Number.isFinite(n) ? n : null
}

export function normalizeLines(raw: unknown): NormalizedLine[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((li: LineInput) => ({
      quantity: num(li.quantity),
      description: typeof li.description === "string" ? li.description.trim() || null : null,
      unit_price: num(li.unit_price),
    }))
    // Drop fully-empty rows so a stray blank line never persists.
    .filter(l => l.description || l.quantity != null || l.unit_price != null)
    .map((l, i) => ({ line_no: i + 1, ...l }))
}

export function lineTotal(lines: { quantity: number | null; unit_price: number | null }[]): number {
  return lines.reduce((s, l) => s + (l.quantity ?? 0) * (l.unit_price ?? 0), 0)
}
