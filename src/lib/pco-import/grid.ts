// Pure, exceljs-agnostic grid helpers for label-anchored extraction.
//
// A Grid is a 0-based [row][col] matrix of normalized cells. ALL extraction
// logic works on a Grid, so it is unit-testable with synthetic fixtures and
// has NO dependency on the workbook reader (parse.ts builds Grids from exceljs).
// Label-anchored: we locate a label cell by its text, then read the value from
// a neighbouring cell — NEVER from a fixed row/column coordinate.

export interface GridCell {
  text: string          // trimmed display text ("" when empty)
  num: number | null    // numeric value when the source cell was a number
  volatile?: boolean    // cell was a volatile formula (TODAY()/NOW()) — never trust as data
}
export type Grid = GridCell[][]
export interface Coord { r: number; c: number }

export const EMPTY_CELL: GridCell = { text: "", num: null }

// Build a Grid from a plain matrix (numbers stay numeric, strings stay text,
// null/undefined = empty). For synthetic fixtures + unit tests without exceljs.
export function gridFromRows(rows: (string | number | null | undefined)[][]): Grid {
  return rows.map(row => row.map<GridCell>(v => {
    if (v == null || v === "") return { text: "", num: null }
    if (typeof v === "number") return { text: String(v), num: v }
    return { text: String(v).trim(), num: null }
  }))
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// Parse a money/number-looking string: "$1,234.56", "(1,234.56)" → -1234.56,
// "2,704.61" → 2704.61. Returns null when there's no number in the text.
export function parseMoney(text: string): number | null {
  if (!text) return null
  const t = text.trim()
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t)
  const digits = t.replace(/[^0-9.]/g, "")
  if (digits === "" || digits === ".") return null
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

// The numeric interpretation of a cell: the stored number if any, else a number
// parsed out of its text (money strings, "5", etc.).
export function cellNum(cell: GridCell | undefined): number | null {
  if (!cell) return null
  if (cell.num != null && Number.isFinite(cell.num)) return cell.num
  return parseMoney(cell.text)
}

export function cellText(cell: GridCell | undefined): string {
  return cell?.text ?? ""
}

export function isEmpty(cell: GridCell | undefined): boolean {
  return !cell || (cell.text === "" && cell.num == null)
}

export function at(grid: Grid, r: number, c: number): GridCell {
  return grid[r]?.[c] ?? EMPTY_CELL
}

// Normalize for label comparison: lowercase, collapse whitespace, drop trailing
// ":" / "#" decorations and surrounding punctuation.
export function normLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:#.\s]+$/g, "")
    .trim()
}

export function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

// First cell (row-major) whose normalized text satisfies `match`.
export function findLabelCell(grid: Grid, match: (normalized: string, raw: string) => boolean): Coord | null {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    for (let c = 0; c < row.length; c++) {
      const txt = row[c]?.text ?? ""
      if (txt === "") continue
      if (match(normLabel(txt), txt)) return { r, c }
    }
  }
  return null
}

// All row indices whose normalized text in ANY column satisfies `match`.
export function findRows(grid: Grid, match: (normalized: string, raw: string) => boolean): number[] {
  const out: number[] = []
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    if (row.some(cell => cell && cell.text !== "" && match(normLabel(cell.text), cell.text))) out.push(r)
  }
  return out
}

// First non-empty cell to the right of `coord`, within `maxSpan` columns.
// (Merged value cells: the master holds the value, so the first non-empty hit
// is the merged value.)
export function valueRightOf(grid: Grid, coord: Coord, maxSpan = 8): GridCell | null {
  for (let c = coord.c + 1; c <= coord.c + maxSpan; c++) {
    const cell = at(grid, coord.r, c)
    if (!isEmpty(cell)) return cell
  }
  return null
}

// First cell to the right whose numeric interpretation is non-null.
export function numberRightOf(grid: Grid, coord: Coord, maxSpan = 10): number | null {
  for (let c = coord.c + 1; c <= coord.c + maxSpan; c++) {
    const n = cellNum(at(grid, coord.r, c))
    if (n != null) return n
  }
  return null
}

// First non-empty cell below `coord`, within `maxSpan` rows.
export function valueBelowOf(grid: Grid, coord: Coord, maxSpan = 3): GridCell | null {
  for (let r = coord.r + 1; r <= coord.r + maxSpan; r++) {
    const cell = at(grid, r, coord.c)
    if (!isEmpty(cell)) return cell
  }
  return null
}

// Read the value associated with a label: prefer the cell to its right; if the
// whole row to the right is empty, fall back to the cell directly below.
export function readLabeledText(grid: Grid, coord: Coord, maxSpan = 8): string {
  const right = valueRightOf(grid, coord, maxSpan)
  if (right && right.text !== "") return right.text
  const below = valueBelowOf(grid, coord, 2)
  return below?.text ?? ""
}

export function readLabeledNumber(grid: Grid, coord: Coord, maxSpan = 10): number | null {
  const right = numberRightOf(grid, coord, maxSpan)
  if (right != null) return right
  const below = valueBelowOf(grid, coord, 2)
  return cellNum(below ?? undefined)
}
