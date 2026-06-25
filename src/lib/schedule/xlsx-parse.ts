// ── Schedule-import: XLSX pull-plan parser (ADR-012 follow-up) ────────────────
// THP also issues the pull-plan ACTIVITY LIST as a spreadsheet intake form. Same
// columns as the Gilbane PDF pull-plan (Bid Package Responsibility | Work Activity |
// Duration | Crew Size) and the SAME destination — undated BACKLOG tasks. The new
// wrinkle: one sheet holds MULTIPLE project BLOCKS, each its own titled mini-table
// (e.g. "150 York Corridor", "1156 Chapel (interior)", "353 Crown (Level 1)"), laid
// out stacked vertically OR side-by-side across columns.
//
// DESIGN — structure-generic, like the PDF parsers (NOT tuned to one sheet's coords):
//   • A BLOCK is found by its HEADER SIGNATURE: a "Work Activity" name cell with a
//     Duration / Crew Size / Bid-Package label in the same row, in adjacent columns.
//     Each name anchor = one block, so a single row-by-row scan finds BOTH layouts —
//     side-by-side (many headers in one row) and stacked (headers down a column).
//   • Column mapping is DERIVED from each header's own label positions: bid-package
//     to the LEFT of the name, duration/crew to the RIGHT — never fixed coordinates.
//   • The block TITLE is the nearest non-empty, non-label cell ABOVE the header in
//     the block's column span (the colored/merged project-name cell — exceljs puts a
//     merged value on its top-left master, so the leftmost hit is the title).
//   • Rows read DOWN each block's name column until a blank name OR the next
//     overlapping block's header/title — so a short block beside a long one, and two
//     stacked blocks, separate cleanly.
//   • Every row → a BACKLOG task: null dates; parsed crew_size + nominal
//     duration_days; phase = "<block title> › <responsibility>" — the project block
//     rides the EXISTING phase string (no schema column added), so the review modal
//     groups + keyword-filters by project block and the user can import one block.
//     Field parsing is shared with the PDF path via pullplan-fields.ts.
//
// The exceljs read is the only I/O; the core (parsePullPlanGrid) works on a plain
// Grid, so it is unit-testable with synthetic fixtures and ships no .xlsx binaries —
// same split as import-parse.ts (pure core) + pdf-words.ts (I/O seam).

import type { Grid, GridCell } from "../pco-import/grid"
import { at, cellText, normLabel } from "../pco-import/grid"
import type { ParseResult, ProposedTaskRow } from "./import-parse"
import { finalizePullPlanRow, parsePullPlanCrew, parsePullPlanDuration } from "./pullplan-fields"

// Header vocabulary — the THP pull-plan signature, plus a few obvious synonyms.
// Matched on normLabel (lowercased, whitespace-collapsed, trailing :/#/. stripped),
// EXACT match — same discipline as the PDF parser's HEADER_LABELS.
const NAME_LABELS = ["work activity", "work activities", "activity name", "task name"]
const BIDPKG_LABELS = ["bid package responsibility", "bid package", "responsibility"]
const DUR_LABELS = ["duration", "duration (days)", "dur"]
const CREW_LABELS = ["crew size", "crew", "crew size (people)", "manpower"]
const isAnyHeaderLabel = (n: string) =>
  NAME_LABELS.includes(n) || BIDPKG_LABELS.includes(n) || DUR_LABELS.includes(n) || CREW_LABELS.includes(n)

interface BlockHeader {
  row: number
  nameCol: number
  bidpkgCol: number | null
  durationCol: number | null
  crewCol: number | null
  colStart: number
  colEnd: number
}

// Find the FIRST column in [lo,hi] whose label is in `set`.
function findLabelCol(grid: Grid, row: number, lo: number, hi: number, set: string[]): number | null {
  for (let c = Math.max(0, lo); c <= hi; c++) {
    const n = normLabel(cellText(at(grid, row, c)))
    if (n && set.includes(n)) return c
  }
  return null
}

// Detect every block header on the sheet. A "Work Activity" cell anchors a block;
// its mapping is read from a tight window (bid-package to the left, duration/crew to
// the right) so adjacent side-by-side blocks never steal each other's columns.
function detectBlockHeaders(grid: Grid): BlockHeader[] {
  const out: BlockHeader[] = []
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    for (let c = 0; c < row.length; c++) {
      if (!NAME_LABELS.includes(normLabel(cellText(row[c])))) continue
      const nameCol = c
      const bidpkgCol = findLabelCol(grid, r, nameCol - 3, nameCol - 1, BIDPKG_LABELS)
      const durationCol = findLabelCol(grid, r, nameCol + 1, nameCol + 4, DUR_LABELS)
      const crewCol = findLabelCol(grid, r, nameCol + 1, nameCol + 6, CREW_LABELS)
      const present = [bidpkgCol, durationCol, crewCol].filter((x): x is number => x !== null)
      // A lone "Work Activity" with no duration/crew/bid-package nearby isn't a
      // pull-plan header (mirrors the PDF parser's name-plus-one qualifying rule).
      if (present.length === 0) continue
      const cols = [nameCol, ...present]
      out.push({
        row: r, nameCol, bidpkgCol, durationCol, crewCol,
        colStart: Math.min(...cols), colEnd: Math.max(...cols),
      })
    }
  }
  return out
}

const overlaps = (a: BlockHeader, b: BlockHeader) => a.colStart <= b.colEnd && b.colStart <= a.colEnd

// The colored/merged project-name cell above the header, within the block's column
// span (scan ≤ 3 rows up; first non-empty, non-header-label cell wins).
function titleAbove(grid: Grid, h: BlockHeader): string | null {
  const top = Math.max(0, h.row - 3)
  for (let r = h.row - 1; r >= top; r--) {
    for (let c = Math.max(0, h.colStart - 1); c <= h.colEnd; c++) {
      const t = cellText(at(grid, r, c)).replace(/\s+/g, " ").trim()
      if (!t || isAnyHeaderLabel(normLabel(t))) continue
      return t
    }
  }
  return null
}

const composePhase = (title: string | null, resp: string | null): string | null =>
  title && resp ? `${title} › ${resp}` : title || resp || null

// Read one block's data rows downward from its header.
function blockRows(grid: Grid, h: BlockHeader, all: BlockHeader[], title: string | null): ProposedTaskRow[] {
  const rows: ProposedTaskRow[] = []
  for (let r = h.row + 1; r < grid.length; r++) {
    // Boundary: the next overlapping (stacked) block's header row stops this block.
    // The next block's TITLE row stops us too, but via the blank-name break below —
    // a merged/colored title leaves this block's NAME column empty (its master sits
    // at the block's left edge), so we don't need a separate title-row guard (and a
    // guard keyed on header-row±1 would wrongly drop a last data row when two blocks
    // stack with no title/blank between them).
    if (all.some((o) => o !== h && overlaps(o, h) && o.row === r)) break
    const name = cellText(at(grid, r, h.nameCol)).replace(/\s+/g, " ").trim()
    if (!name) break // a blank activity name ends the block (incl. the next title row)
    if (isAnyHeaderLabel(normLabel(name))) break // a stray repeated header label
    const resp = h.bidpkgCol !== null ? cellText(at(grid, r, h.bidpkgCol)).replace(/\s+/g, " ").trim() : ""
    const duration = h.durationCol !== null ? parsePullPlanDuration(cellText(at(grid, r, h.durationCol))) : null
    const crew = h.crewCol !== null ? parsePullPlanCrew(cellText(at(grid, r, h.crewCol))) : null
    rows.push(finalizePullPlanRow(name, composePhase(title, resp || null), duration, crew, false))
  }
  return rows
}

// ── Pure core: a list of sheet Grids → proposed BACKLOG rows ──────────────────
export function parsePullPlanGrid(sheets: Grid[]): ParseResult {
  const rows: ProposedTaskRow[] = []
  const summaries: string[] = []
  let blockCount = 0
  for (const grid of sheets) {
    const headers = detectBlockHeaders(grid)
    for (const h of headers) {
      const title = titleAbove(grid, h)
      const blockRowsOut = blockRows(grid, h, headers, title)
      if (blockRowsOut.length === 0) continue
      blockCount++
      rows.push(...blockRowsOut)
      summaries.push(`${title ?? "Untitled block"} (${blockRowsOut.length})`)
    }
  }

  const warnings: string[] = []
  if (blockCount === 0) {
    warnings.push('No pull-plan activity blocks were found — expected a header row with "Work Activity" plus "Duration" or "Crew Size".')
  } else {
    warnings.push(`Detected ${blockCount} project block${blockCount === 1 ? "" : "s"}: ${summaries.join(", ")}.`)
  }
  return { family: "pullplan", pageCount: sheets.length, rows, warnings }
}

// ── exceljs I/O seam ──────────────────────────────────────────────────────────
const MAX_ROWS = 2000
const MAX_COLS = 100

// exceljs cell value → normalized GridCell. Mirrors the PCO reader's normalizer:
// resolves rich text + formula results, leaves dates empty (a pull-plan carries
// none), and never produces "[object Object]".
function normalizeCellValue(value: unknown): GridCell {
  if (value == null) return { text: "", num: null }
  if (typeof value === "number") return Number.isFinite(value) ? { text: String(value), num: value } : { text: "", num: null }
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", num: null }
  if (typeof value === "string") return { text: value.trim(), num: null }
  if (value instanceof Date) return { text: "", num: null }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.richText)) return { text: (v.richText as { text?: string }[]).map((t) => t.text ?? "").join("").trim(), num: null }
    if ("result" in v) return normalizeCellValue(v.result) // formula / shared-formula cell
    if (typeof v.text === "string") return { text: (v.text as string).trim(), num: null } // hyperlink
  }
  return { text: "", num: null }
}

interface XlsxWorksheet {
  rowCount: number
  columnCount: number
  getRow: (r: number) => { getCell: (c: number) => { value: unknown } }
}

function gridFromWorksheet(ws: XlsxWorksheet): Grid {
  const rows = Math.min(ws.rowCount || 0, MAX_ROWS)
  const cols = Math.min(ws.columnCount || 0, MAX_COLS)
  const grid: Grid = []
  for (let r = 1; r <= rows; r++) {
    const wr = ws.getRow(r)
    const row: GridCell[] = []
    for (let c = 1; c <= cols; c++) row.push(normalizeCellValue(wr.getCell(c).value))
    grid.push(row)
  }
  return grid
}

// Read workbook bytes into sheet Grids and parse. Takes an ArrayBuffer (what
// File.arrayBuffer() yields) — same as the PCO reader; exceljs accepts it directly.
// exceljs is dynamic-imported so its ~600 KB stays out of bundles that don't parse a
// spreadsheet.
export async function parsePullPlanXlsx(data: ArrayBuffer): Promise<ParseResult> {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data)
  const sheets = wb.worksheets.map((ws) => gridFromWorksheet(ws as unknown as XlsxWorksheet))
  return parsePullPlanGrid(sheets)
}
