// Server-safe (no exceljs) shapes + mapping for the import commit/preview path.
// The reviewed/edited PCO arrives from the browser as ImportPcoPayload; the
// server recomputes pricing from the line items (never trusts the client total)
// using the SAME helpers as the PCO builder (computePcoPricingSum /
// buildLineItemRows from pco-save), so imported and manual PCOs price one way.

import type { PcoDocData } from "@/lib/pco-pdf"
import type { PcoSaveBody } from "@/lib/pco-save"

export interface ImportLaborInput {
  description?: string | null
  qty_reg?: number | null; rate_reg?: number | null
  qty_ot?: number | null;  rate_ot?: number | null
  qty_dt?: number | null;  rate_dt?: number | null
}
export interface ImportMaterialInput {
  description?: string | null
  qty?: number | null; unit?: string | null; unit_price?: number | null; note?: string | null
}
export interface ImportSubInput { description?: string | null; amount?: number | null }

// One reviewed PCO ready to commit. oh_p_percent / fee_percent are FRACTIONS.
// confirmed_total is what the user saw/approved in review; the server verifies
// its own recomputed pricing_sum against it before inserting.
export interface ImportPcoPayload extends PcoSaveBody {
  project_id: string
  pco_number: string
  date?: string | null
  title?: string
  description_of_work?: string | null
  schedule_impact_days?: number | string | null
  signer_name?: string | null
  signer_title?: string | null
  labor?: ImportLaborInput[]
  materials?: ImportMaterialInput[]
  subs?: ImportSubInput[]
  confirmed_total?: number | null
  // Optional review status to apply AFTER commit via the normal status-update
  // path (import_pco itself always inserts 'Not submitted'). Log-workflow state,
  // not document content.
  status?: string | null
}

export interface ImportProjectContext {
  name: string | null
  number: string | null
  location: string | null
}

// Map a reviewed payload to the pure PDF data object (no DB row required).
export function payloadToDocData(p: ImportPcoPayload, project: ImportProjectContext): PcoDocData {
  return {
    pcoNumber: p.pco_number,
    jobNumber: project.number,
    dateISO: p.date ?? null,
    title: typeof p.title === "string" ? p.title : null,
    descriptionOfWork: p.description_of_work ?? null,
    labor: (p.labor ?? []).map(l => ({
      description: l.description ?? null,
      qty_reg: l.qty_reg ?? null, rate_reg: l.rate_reg ?? null,
      qty_ot: l.qty_ot ?? null,   rate_ot: l.rate_ot ?? null,
      qty_dt: l.qty_dt ?? null,   rate_dt: l.rate_dt ?? null,
    })),
    materials: (p.materials ?? []).map(m => ({
      description: m.description ?? null,
      qty: m.qty ?? null, unit: m.unit ?? null, unit_price: m.unit_price ?? null, note: m.note ?? null,
    })),
    subs: (p.subs ?? []).map(s => ({ description: s.description ?? null, amount: s.amount ?? null })),
    ohpPercent: p.oh_p_percent ?? null,
    feePercent: p.fee_percent ?? null,
    scheduleImpactDays: parseSchedDays(p.schedule_impact_days),
    signerName: p.signer_name ?? null,
    signerTitle: p.signer_title ?? null,
    projectName: project.name,
    projectLocation: project.location,
  }
}

export function parseSchedDays(v: number | string | null | undefined): number {
  if (v === undefined || v === null || v === "") return 0
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : 0
}
