// Client-side THP-workbook reader. The ONLY module that touches exceljs; it
// builds Grids from worksheets and hands off to the pure extract.ts. exceljs is
// dynamic-imported so the ~600 KB library stays out of the bundle until import.
//
// The uploaded workbook is parsed in memory and NEVER uploaded/stored.

import type { Grid, GridCell } from "./grid"
import { norm, findLabelCell, findRows } from "./grid"
import type { ParsedFileResult, ParsedPco, PcoFlag, StatedPricing } from "./types"
import { extractCover, extractBackup, reconcile, normalizePcoNumber } from "./extract"

const MAX_ROWS = 500
const MAX_COLS = 60

// ── exceljs cell value → normalized GridCell ────────────────────────────────
function isoFromDate(d: Date): string {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function normalizeCellValue(value: unknown): GridCell {
  if (value == null) return { text: "", num: null }
  if (typeof value === "number") return { text: Number.isFinite(value) ? String(value) : "", num: Number.isFinite(value) ? value : null }
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", num: null }
  if (typeof value === "string") return { text: value.trim(), num: null }
  if (value instanceof Date) return { text: isoFromDate(value), num: null }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    // Formula cell: { formula, result }
    if ("result" in v) return normalizeCellValue(v.result)
    // Rich text: { richText: [{ text }] }
    if (Array.isArray(v.richText)) return { text: (v.richText as { text?: string }[]).map(t => t.text ?? "").join("").trim(), num: null }
    // Hyperlink: { text, hyperlink }
    if (typeof v.text === "string") return { text: (v.text as string).trim(), num: null }
    // Error cell: { error }
    if ("error" in v) return { text: "", num: null }
  }
  return { text: String(value).trim(), num: null }
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
  const hasPco = !!findLabelCell(grid, n => n.includes("pco"))
  const hasCoverField = !!findLabelCell(grid, n => n.includes("project") || n === "title" || n.includes("description"))
  return hasPco && hasCoverField
}
function looksLikeBackup(grid: Grid): boolean {
  const hasLabor = !!findLabelCell(grid, n => n === "labor" || n.startsWith("labor"))
  const hasMarker = findRows(grid, n => n.includes("total hours")).length > 0
    || findRows(grid, n => n.includes("materials subtotal")).length > 0
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
  const coverByName = sheets.find(s => norm(s.name).includes("cover"))
  const backupByName = sheets.find(s => norm(s.name).includes("backup"))
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

  // Cross-check: Cover PCO # must equal Backup PCO #.
  if (cover.pcoNumber && backup.pcoNumber && cover.pcoNumber !== backup.pcoNumber) {
    flags.push({ code: "pco_number_mismatch", message: `Cover PCO # (${cover.pcoNumber}) ≠ Backup PCO # (${backup.pcoNumber}). Resolve before committing.` })
  }

  const stated: StatedPricing = {
    coverLabor: cover.cover.coverLabor,
    coverMaterials: cover.cover.coverMaterials,
    coverSubcontractor: cover.cover.coverSubcontractor,
    coverFee: cover.cover.coverFee,
    coverBond: cover.cover.coverBond,
    coverTotal: cover.cover.coverTotal,
    backupLaborSubtotal: backup.backup.backupLaborSubtotal,
    backupMaterialsSubtotal: backup.backup.backupMaterialsSubtotal,
    backupOhpAmount: backup.backup.backupOhpAmount,
    backupGrandTotal: backup.backup.backupGrandTotal,
  }

  const { computed, flags: integrityFlags } = reconcile(backup.labor, backup.materials, stated)
  flags.push(...integrityFlags)

  if (backup.dropped > 0) notes.push(`Dropped ${backup.dropped} zero-quantity row${backup.dropped === 1 ? "" : "s"}.`)

  // Required fields for a committable PCO.
  const pcoNumber = cover.pcoNumber ?? backup.pcoNumber
  if (!pcoNumber) flags.push({ code: "missing_fields", field: "PCO #", message: "PCO # could not be read." })
  if (!cover.title) flags.push({ code: "missing_fields", field: "Title", message: "Title could not be read." })
  if (!cover.dateISO && !backup.dateISO) flags.push({ code: "missing_fields", field: "Date", message: "Date could not be read." })
  if (backup.labor.length === 0 && backup.materials.length === 0) flags.push({ code: "missing_fields", field: "Line items", message: "No labor or material lines were found." })

  const pco: ParsedPco = {
    sourceFileName: file.name,
    sourceSheetCover: coverSheet.name,
    sourceSheetBackup: backupSheet.name,
    pcoNumber,
    pcoNumberRaw: cover.pcoNumberRaw ?? backup.pcoNumberRaw,
    project: cover.project,
    dateISO: cover.dateISO ?? backup.dateISO,
    title: cover.title,
    descriptionOfWork: cover.descriptionOfWork,
    scheduleImpactDays: cover.scheduleImpactDays,
    signerName: cover.signerName,
    signerTitle: cover.signerTitle,
    jobNumber: backup.jobNumber,
    labor: backup.labor,
    materials: backup.materials,
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
