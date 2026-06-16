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

// ─── Release-order link (PO → parent supplier_contract) ──────────────────────
// A PO may optionally be "released against" a supplier_contract. The link is
// only valid when the parent is a supplier_contract on the SAME project AND the
// SAME vendor as the PO. The DB commitments_parent_rules CHECK only guarantees
// "type=purchase_order, no self-parent" — the project/vendor/contract-type rule
// is enforced here, server-side, on every write.

export interface ParentCommitmentRow { id: string; type: string; project_id: string; vendor_id: string | null }

// Returns a human-readable rejection reason, or null when the link is allowed.
// The caller MUST fetch `parent` through the RLS-scoped server client first; a
// null fetch means the row isn't visible to this company and the caller should
// reject before reaching here (so visibility is never decided in this pure fn).
export function releaseParentError(parent: ParentCommitmentRow, projectId: string, vendorId: string): string | null {
  if (parent.type !== "supplier_contract") return "The release-against parent must be a supplier contract."
  if (parent.project_id !== projectId)      return "The release-against contract must be on the same project as the PO."
  if (parent.vendor_id !== vendorId)        return "The release-against contract must be for the same vendor as the PO."
  return null
}
