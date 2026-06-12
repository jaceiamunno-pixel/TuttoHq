// Types for the historical-PCO import (THP-format .xlsx → TuttoHQ PCO).
//
// The workbook is parsed in the browser and NEVER stored. These shapes carry
// the extracted, human-reviewable data through: parse → review/edit → commit.
// Currency is rounded to cents at extraction; source cells carry float
// artifacts (e.g. 2704.6099999999997).

export type PcoFlagCode =
  | "pco_number_mismatch"   // Cover # ≠ Backup # — NON-BLOCKING notice (cover is authoritative; stale backup copy is normal)
  | "pco_number_unverified" // Cover # missing entirely; fell back to backup # — BLOCKING (no trustworthy number)
  | "math_mismatch"         // recomputed subtotal/total ≠ stated value (> tolerance)
  | "collision"             // PCO # already exists in this project's log
  | "missing_fields"        // a required field could not be located
  | "volatile_date"         // the only date is a TODAY()/NOW() formula — must confirm
  | "unsupported_value"     // a value with no TuttoHQ model slot (e.g. Bond ≠ 0)
  | "parse_error"           // the file/sheet could not be read at all

export interface PcoFlag {
  code: PcoFlagCode
  message: string
  // For math_mismatch: the two numbers to show side-by-side in review.
  computed?: number
  stated?: number
  field?: string
}

export interface ParsedLaborLine {
  role: string | null
  qty_reg: number | null; rate_reg: number | null
  qty_ot: number | null;  rate_ot: number | null
  qty_dt: number | null;  rate_dt: number | null
  lineTotal: number | null   // stated total from the file (display/integrity only)
}

export interface ParsedMaterialLine {
  item: string | null
  qty: number | null
  unit: string | null
  unit_price: number | null
  note: string | null        // THP free-text "description" column
  lineTotal: number | null
}

// Stated pricing values as read from the file (the "truth" we reconcile against).
export interface StatedPricing {
  // Cover Sheet pricing summary
  coverLabor: number | null
  coverMaterials: number | null
  coverSubcontractor: number | null
  coverFee: number | null
  coverBond: number | null
  coverTotal: number | null
  // Backup Template subtotals
  backupLaborSubtotal: number | null
  backupMaterialsSubtotal: number | null
  backupOhpAmount: number | null
  backupGrandTotal: number | null   // pre-fee grand total on the backup
}

// Values recomputed from the extracted line items (drives the integrity check).
export interface ComputedPricing {
  laborSubtotal: number
  materialsSubtotal: number
  ohpPercent: number | null   // FRACTION, derived from backup OH&P amount
  feePercent: number | null   // FRACTION, derived from cover Fee amount
  subcontractor: number
  total: number               // == computePcoTotals(...).grandTotal
}

export interface ParsedPco {
  // provenance
  sourceFileName: string
  sourceSheetCover: string | null
  sourceSheetBackup: string | null
  // identity
  pcoNumber: string | null      // normalized display, e.g. "042"
  pcoNumberRaw: string | null
  // cover fields
  project: string | null
  dateISO: string | null        // 'YYYY-MM-DD' — null when only a volatile date exists
  dateSuggestion: string | null // cached value of a volatile TODAY()/NOW() date (a hint, never auto-used)
  title: string | null
  descriptionOfWork: string | null
  scheduleImpactDays: number | null
  signerName: string | null
  signerTitle: string | null
  // backup fields
  jobNumber: string | null
  labor: ParsedLaborLine[]
  materials: ParsedMaterialLine[]
  // reconciliation
  stated: StatedPricing
  computed: ComputedPricing
  flags: PcoFlag[]
  notes: string[]               // e.g. ignored prem-time sheets, dropped zero-qty rows
}

export interface ParsedFileResult {
  fileName: string
  pco: ParsedPco | null         // null only on a hard parse failure
  fileFlags: PcoFlag[]          // file-level (missing sheets, cover/backup mismatch)
  notes: string[]
}

// Has this PCO got anything blocking commit? (UI gating mirror of the server.)
export function pcoIsCommittable(p: ParsedPco): boolean {
  return p.flags.length === 0
}
