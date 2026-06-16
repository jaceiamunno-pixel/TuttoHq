// Client-side THP-workbook reader. The ONLY module that touches exceljs; it
// builds Grids from worksheets and hands off to the pure extract.ts. exceljs is
// dynamic-imported so the ~600 KB library stays out of the bundle until import.
//
// The uploaded workbook is parsed in memory and NEVER uploaded/stored.

import type { Grid, GridCell } from "./grid"
import { norm, findLabelCell, findRows } from "./grid"
import type { ParsedFileResult, ParsedPco, PcoFlag, StatedPricing } from "./types"
import { extractCover, extractBackup, reconcile, normalizePcoNumber, extractPcoCandidates } from "./extract"

const MAX_ROWS = 500
const MAX_COLS = 60

// ── exceljs cell value → normalized GridCell ────────────────────────────────
function isoFromDate(d: Date): string {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// Every read resolves formula/shared-formula cells to their cached result
// uniformly (the THP backup computes line totals, subtotals, OH&P, grand total
// via formulas). A volatile date formula (TODAY()/NOW()) is flagged so the
// parser never trusts it as a real date.
function normalizeCellValue(value: unknown): GridCell {
  if (value == null) return { text: "", num: null }
  if (typeof value === "number") return Number.isFinite(value) ? { text: String(value), num: value } : { text: "", num: null }
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", num: null }
  if (typeof value === "string") return { text: value.trim(), num: null }
  if (value instanceof Date) return { text: isoFromDate(value), num: null }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    // Rich text: { richText: [{ text }] }
    if (Array.isArray(v.richText)) return { text: (v.richText as { text?: string }[]).map(t => t.text ?? "").join("").trim(), num: null }
    // Formula or shared-formula cell → cached result (or empty if uncomputed).
    if ("formula" in v || "sharedFormula" in v) {
      const formulaText = typeof v.formula === "string" ? v.formula : ""
      const base = "result" in v ? normalizeCellValue(v.result) : { text: "", num: null }
      return /\b(today|now)\s*\(/i.test(formulaText) ? { ...base, volatile: true } : base
    }
    if ("result" in v) return normalizeCellValue(v.result)
    // Hyperlink: { text, hyperlink }
    if (typeof v.text === "string") return { text: (v.text as string).trim(), num: null }
    // Error cell: { error }
  }
  return { text: "", num: null }   // unknown object → empty (never "[object Object]")
}

// exceljs worksheet → dense 0-based Grid (capped to keep PCO sheets small).
function gridFromWorksheet(ws: { rowCount: number; columnCount: number; getRow: (r: number) => { getCell: (c: number) => { value: unknown } } }): Grid {
  const rows = Math.min(ws.rowCount || 0, MAX_ROWS)
  const cols = Math.min(ws.columnCount || 0, MAX_COLS)
  const grid: Grid = []
  for (let r = 1; r <= rows; r++) {
    const row: GridCell[] = []
    const wr = ws.getRow(r)
    for (let c = 1; c <= cols; c++) row.push(normalizeCellValue(wr.getCell(c).value))
    grid.push(row)
  }
  return grid
}

// ── sheet classification ────────────────────────────────────────────────────
function looksLikeCover(grid: Grid): boolean {
  // PCO marker: "PCO" / "THP PCO #" (new) or "Proposed Change Order" (old title cell).
  const hasPco = !!findLabelCell(grid, n => n.includes("pco") || n.includes("proposed change order"))
  // Cover field vocabulary spans both formats: PROJECT / RE: / TITLE / Scope of Work / Description.
  const hasCoverField = !!findLabelCell(grid, n =>
    n.includes("project") || n === "re" || n.startsWith("re ") ||
    n === "title" || n.startsWith("title") || n.includes("subject") ||
    n.includes("description") || n.includes("scope"))
  return hasPco && hasCoverField
}
function looksLikeBackup(grid: Grid): boolean {
  const hasLabor = !!findLabelCell(grid, n => n === "labor" || n.startsWith("labor"))
  const hasMarker = findRows(grid, n => n.includes("total hours") || n.includes("total hrs")).length > 0
    || findRows(grid, n => n.includes("materials subtotal") || n.includes("material subtotal")).length > 0
    || findRows(grid, n => n.includes("grand total")).length > 0
  return hasLabor && hasMarker
}

interface Sheet { name: string; grid: Grid }

// ── parse one file ──────────────────────────────────────────────────────────
export async function parseWorkbookFile(file: File): Promise<ParsedFileResult> {
  const fileFlags: PcoFlag[] = []
  const notes: string[] = []
  let sheets: Sheet[]
  try {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())
    sheets = wb.worksheets.map(ws => ({ name: ws.name, grid: gridFromWorksheet(ws as never) }))
  } catch (e) {
    return { fileName: file.name, pco: null, notes, fileFlags: [{ code: "parse_error", message: `Could not read workbook: ${(e as Error)?.message ?? "unknown error"}` }] }
  }

  const isPrem = (name: string) => norm(name).includes("prem")
  // Exclude prem-time sheets from name matching too — real files carry
  // "Prem.Time Cover Sheet" / "Prem.Time Bckp Sheet" that would otherwise win.
  const coverByName = sheets.find(s => !isPrem(s.name) && norm(s.name).includes("cover"))
  const backupByName = sheets.find(s => !isPrem(s.name) && norm(s.name).includes("backup"))
  const coverSheet = coverByName ?? sheets.find(s => !isPrem(s.name) && looksLikeCover(s.grid))
  const backupSheet = backupByName ?? sheets.find(s => !isPrem(s.name) && s !== coverSheet && looksLikeBackup(s.grid))

  if (!coverSheet || !backupSheet) {
    if (!coverSheet) fileFlags.push({ code: "missing_fields", message: "No Cover Sheet found (by name or by the 'THP PCO #' anchor)." })
    if (!backupSheet) fileFlags.push({ code: "missing_fields", message: "No Backup Template found (by name or by the Labor/Total Hours markers)." })
    return { fileName: file.name, pco: null, notes, fileFlags }
  }

  const cover = extractCover(coverSheet.grid)
  const backup = extractBackup(backupSheet.grid)

  // Prem-time sheets: ignored unless their PCO # matches the cover's. Real files
  // carry stale prem-time sheets from OTHER jobs (verified in THP PCO 042).
  for (const s of sheets) {
    if (!isPrem(s.name)) continue
    const sPco = extractPcoNumberFromSheet(s.grid)
    if (sPco && cover.pcoNumber && normalizePcoNumber(sPco) === cover.pcoNumber) {
      notes.push(`Prem-time sheet "${s.name}" matches PCO ${cover.pcoNumber}; premium-time detail is carried in the backup labor lines, not imported separately.`)
    } else {
      notes.push(`Ignored prem-time sheet "${s.name}"${sPco ? ` (its PCO ${normalizePcoNumber(sPco)} ≠ cover PCO ${cover.pcoNumber ?? "?"})` : " (stale sheet from another job)"}.`)
    }
  }

  const flags: PcoFlag[] = []
  const TOL = 0.05

  const stated: StatedPricing = {
    coverLabor: cover.cover.coverLabor,
    coverMaterials: cover.cover.coverMaterials,
    coverSubcontractor: cover.cover.coverSubcontractor,
    coverOhp: cover.cover.coverOhp,
    coverFee: cover.cover.coverFee,
    coverTextura: cover.cover.coverTextura,
    coverBond: cover.cover.coverBond,
    coverTotal: cover.cover.coverTotal,
    backupLaborSubtotal: backup.backup.backupLaborSubtotal,
    backupMaterialsSubtotal: backup.backup.backupMaterialsSubtotal,
    backupOhpAmount: backup.backup.backupOhpAmount,
    backupGrandTotal: backup.backup.backupGrandTotal,
  }

  // PCO #: the COVER SHEET is authoritative everywhere (row number, collision
  // key, prem-time matching). Two DIFFERENT strong cover values (cell values) →
  // we can't tell which, so block.
  const coverStrong = extractPcoCandidates(coverSheet.grid).strong
  if (coverStrong.length > 1) {
    flags.push({ code: "pco_number_conflict", message: `Cover Sheet shows conflicting PCO #s (${coverStrong.join(", ")}). Resolve before committing.` })
  }

  // Line detail comes from the BACKUP. THP workbooks are copied from prior PCOs,
  // so the backup number is often stale (cover# ≠ backup#) — that alone is a
  // benign notice IF the backup's line detail still reconciles to the cover
  // summary. When it does NOT reconcile, the backup belonged to another PCO: omit
  // its line items entirely (never write another PCO's lines) and keep only the
  // cover summary.
  const recon0 = reconcile(backup.labor, backup.materials, stated)
  let laborLines = backup.labor
  let materialLines = backup.materials
  let foreignBackup = false
  if (cover.pcoNumber) {
    if (backup.pcoNumber && backup.pcoNumber !== cover.pcoNumber) {
      const labOk = stated.coverLabor == null || Math.abs(recon0.computed.laborSubtotal - stated.coverLabor) <= TOL
      const matOk = stated.coverMaterials == null || Math.abs(recon0.computed.materialsSubtotal - stated.coverMaterials) <= TOL
      if (labOk && matOk) {
        flags.push({ code: "pco_number_mismatch", message: `Backup sheet shows PCO ${backup.pcoNumber} — using cover PCO ${cover.pcoNumber}.` })
      } else {
        foreignBackup = true
        laborLines = []
        materialLines = []
        flags.push({ code: "foreign_backup", message: `Backup sheet belonged to PCO ${backup.pcoNumber} — line detail omitted; cover summary preserved.` })
      }
    }
  } else if (backup.pcoNumber) {
    flags.push({ code: "pco_number_unverified", message: `Cover Sheet PCO # is missing; falling back to the Backup PCO # (${backup.pcoNumber}), which can't be verified. Exclude unless the number is confirmed.` })
  }

  // Recompute against the kept (possibly omitted) lines. In the foreign-backup
  // case the omitted lines won't reconcile to the cover stated subtotals — that's
  // expected, the foreign_backup notice explains it — so drop the now-redundant
  // math_mismatch noise. (math_mismatch is itself non-blocking; the stated cover
  // is authoritative.)
  const { computed, flags: integrityFlags } = foreignBackup ? reconcile([], [], stated) : recon0
  flags.push(...(foreignBackup ? integrityFlags.filter(f => f.code !== "math_mismatch") : integrityFlags))

  if (backup.dropped > 0 && !foreignBackup) notes.push(`Dropped ${backup.dropped} zero-quantity row${backup.dropped === 1 ? "" : "s"}.`)
  if (laborLines.length === 0 && materialLines.length === 0) {
    notes.push(foreignBackup ? "No line detail imported (foreign backup) — cover summary only." : "No line detail in this PCO — committing on the cover summary only.")
  }

  // Date: a static (non-volatile) date is used as-is. A volatile TODAY()/NOW()
  // (real THP files use =TODAY()/=NOW() on both sheets) is NEVER trusted — the
  // card is flagged and the cached value surfaced as a date-only suggestion.
  const staticDate = cover.dateISO ?? backup.dateISO
  const dateSuggestion = cover.dateVolatileCached ?? backup.dateVolatileCached ?? null

  // Required fields. NB: line items are NOT required — a cover-summary-only PCO is
  // valid (stated totals are authoritative).
  const pcoNumber = cover.pcoNumber ?? backup.pcoNumber
  if (!pcoNumber) flags.push({ code: "missing_fields", field: "PCO #", message: "PCO # could not be read." })
  if (!cover.title) flags.push({ code: "missing_fields", field: "Title", message: "Title could not be read." })
  if (!staticDate) {
    flags.push(dateSuggestion
      ? { code: "volatile_date", field: "Date", message: `This file's date is auto-generated by Excel (last showed ${dateSuggestion}). Confirm or enter the PCO date.` }
      : { code: "missing_fields", field: "Date", message: "Date could not be read." })
  }

  const pco: ParsedPco = {
    sourceFileName: file.name,
    sourceSheetCover: coverSheet.name,
    sourceSheetBackup: backupSheet.name,
    pcoNumber,
    pcoNumberRaw: cover.pcoNumberRaw ?? backup.pcoNumberRaw,
    project: cover.project,
    dateISO: staticDate,
    dateSuggestion,
    title: cover.title,
    descriptionOfWork: cover.descriptionOfWork,
    scheduleImpactDays: cover.scheduleImpactDays,
    signerName: cover.signerName,
    signerTitle: cover.signerTitle,
    jobNumber: backup.jobNumber,
    labor: laborLines,
    materials: materialLines,
    stated,
    computed,
    flags,
    notes,
  }
  return { fileName: file.name, pco, fileFlags, notes }
}

function extractPcoNumberFromSheet(grid: Grid): string | null {
  const coord = findLabelCell(grid, n => n.includes("pco"))
  if (!coord) return null
  const row = grid[coord.r] ?? []
  const inline = (row[coord.c]?.text ?? "").match(/pco[^0-9]*([0-9]+)/i)
  if (inline) return inline[1]
  for (let c = coord.c + 1; c <= coord.c + 6; c++) {
    const cell = row[c]
    if (cell && (cell.num != null || /[0-9]/.test(cell.text))) return cell.num != null ? String(cell.num) : cell.text
  }
  return null
}

export async function parseWorkbookFiles(files: File[]): Promise<ParsedFileResult[]> {
  const out: ParsedFileResult[] = []
  for (const f of files) out.push(await parseWorkbookFile(f))
  return out
}
