// Label-anchored extraction of one THP-format PCO from its Cover Sheet grid and
// Backup Template grid. PURE: operates on Grids (see grid.ts), so it is testable
// with synthetic fixtures and shared by the workbook reader (parse.ts).
//
// Design notes:
// - Labels are matched by normalized text, values read from neighbours — never
//   from fixed coordinates (real files have shifting layouts + renamed sheets).
// - Sections are LABEL-BOUNDED: Labor header → 'Total Hours', Material header →
//   'Materials Subtotal'. Blank rows inside a section are tolerated.
// - Labor Qty/Rate columns are mapped by detecting the Qty headers and the
//   (uniquely named) Rate headers INDEPENDENTLY and pairing them left-to-right,
//   so a "Unit" column BETWEEN qty and rate (real THP layout) doesn't misalign
//   them. The header band excludes data rows (firstDataRow-1) so data like "hrs"
//   can't be mistaken for a header.
// - Formula cells are resolved to cached results in parse.ts; a volatile date
//   (TODAY()/NOW()) is flagged and never used (the date comes from the Cover).
// - Currency is rounded to cents at read time (source cells carry float noise).
// - The integrity check (recompute vs stated, ±$0.05) is the safety net for any
//   column-mapping miss: a mismatch flags the PCO rather than committing bad data.

import {
  computePcoTotals, laborLineTotal, materialLineTotal,
} from "@/app/dashboard/_shared/pco-math"
import type {
  ParsedLaborLine, ParsedMaterialLine, StatedPricing, ComputedPricing, PcoFlag,
} from "./types"
import {
  type Grid, type Coord, at, cellNum, cellText, round2, normLabel,
  findLabelCell, findRows, valueRightOf, readLabeledText, readLabeledNumber,
} from "./grid"

const PRICE_TOLERANCE = 0.05

// ── small label predicates ──────────────────────────────────────────────────
const isLabel = (needle: string) => (n: string) => n.includes(needle)
const isExact = (...vals: string[]) => (n: string) => vals.includes(n)

// ── PCO # ───────────────────────────────────────────────────────────────────
export function normalizePcoNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/[^0-9]/g, "")
  if (digits === "") return String(raw).trim() || null
  // Numeric → zero-pad to 3 to match builder PCOs (LPAD(n,3,'0')).
  return digits.padStart(3, "0")
}

// Locate "THP PCO #:" (or any "PCO #") and read the number beside it.
export function extractPcoNumber(grid: Grid): { raw: string | null; normalized: string | null } {
  const coord = findLabelCell(grid, n => n.includes("pco"))
  if (!coord) return { raw: null, normalized: null }
  // Sometimes the label cell itself contains the number ("THP PCO #: 42").
  const inline = cellText(at(grid, coord.r, coord.c)).match(/pco[^0-9]*([0-9]+)/i)
  if (inline) return { raw: inline[1], normalized: normalizePcoNumber(inline[1]) }
  const right = readLabeledText(grid, coord, 6)
  const num = readLabeledNumber(grid, coord, 6)
  const raw = right || (num != null ? String(num) : null)
  return { raw, normalized: normalizePcoNumber(raw) }
}

// ── dates ───────────────────────────────────────────────────────────────────
export function toISODate(text: string): string | null {
  if (!text) return null
  const t = text.trim()
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (us) {
    const mo = us[1].padStart(2, "0")
    const day = us[2].padStart(2, "0")
    let yr = us[3]
    if (yr.length === 2) yr = `20${yr}`
    return `${yr}-${mo}-${day}`
  }
  return null
}

// Read a date from a "Date" label. A volatile cell (TODAY()/NOW()) is NEVER
// returned as the real date; its cached value comes back as a hint only, so the
// reviewer can confirm it. (In real THP files BOTH sheets' dates are =TODAY().)
function readLabeledDate(grid: Grid): { iso: string | null; volatileCached: string | null } {
  const coord = findLabelCell(grid, isExact("date"))
  if (!coord) return { iso: null, volatileCached: null }
  const cell = valueRightOf(grid, coord, 6)
  if (!cell) return { iso: null, volatileCached: null }
  if (cell.volatile) return { iso: null, volatileCached: toISODate(cell.text) }
  return { iso: toISODate(cell.text), volatileCached: null }
}

// ── column mapping for a table band ─────────────────────────────────────────
// Scan the header band [headerRow .. headerRow+depth] and return, per spec key,
// the first column whose header text matches.
type ColSpec = { key: string; match: (n: string) => boolean }
function mapColumns(grid: Grid, headerRow: number, depth: number, specs: ColSpec[]): Record<string, number> {
  const out: Record<string, number> = {}
  const width = Math.max(0, ...grid.slice(headerRow, headerRow + depth + 1).map(row => row?.length ?? 0))
  for (const spec of specs) {
    for (let c = 0; c < width && !(spec.key in out); c++) {
      for (let r = headerRow; r <= headerRow + depth; r++) {
        const txt = cellText(at(grid, r, c))
        if (txt && spec.match(normLabel(txt))) { out[spec.key] = c; break }
      }
    }
  }
  return out
}

// Left-most column that has any text in the data band (the role/item column).
function leftmostTextColumn(grid: Grid, startRow: number, endRow: number): number {
  let best = Infinity
  for (let r = startRow; r < endRow; r++) {
    const row = grid[r]; if (!row) continue
    for (let c = 0; c < row.length; c++) {
      if (cellText(at(grid, r, c)) !== "") { if (c < best) best = c; break }
    }
  }
  return Number.isFinite(best) ? best : 0
}

// First row in [start,end) that carries any numeric cell — i.e. the first DATA
// row of a table. Everything between the header and it is header/blank.
function firstNumericRow(grid: Grid, start: number, end: number): number | null {
  for (let r = start; r < end; r++) {
    const row = grid[r]; if (!row) continue
    for (let c = 0; c < row.length; c++) if (cellNum(at(grid, r, c)) != null) return r
  }
  return null
}

// Map the labor Qty/Rate columns from a header band [headerRow..bandEnd] (data
// rows excluded). Qty columns and the uniquely-named Rate columns are detected
// INDEPENDENTLY and paired left-to-right, so a Unit column sitting between a
// Qty and its Rate (real THP layout: C=Qty, D=Unit, E=Reg Rate) doesn't
// misalign them. Tier order positionally = reg, ot (1.5×/"1-1/2"), dt (2×).
function mapLaborColumns(grid: Grid, headerRow: number, bandEnd: number): {
  tiers: { qty: number; rate: number }[]; total: number | undefined
} {
  const width = Math.max(0, ...grid.slice(headerRow, bandEnd + 1).map(row => row?.length ?? 0))
  const qtyCols: number[] = []
  const rateCols: number[] = []
  let total: number | undefined
  for (let c = 0; c < width; c++) {
    let isQty = false, isRate = false
    for (let r = headerRow; r <= bandEnd; r++) {
      const n = normLabel(cellText(at(grid, r, c)))
      if (!n) continue
      if (n.includes("rate")) isRate = true
      else if (n === "qty" || n === "quantity" || n === "hours" || n === "hrs" || n === "hr" || n.includes("qty")) isQty = true
      if (total === undefined && (n === "total" || n.includes("line total") || n.includes("amount") || n.includes("extension"))) total = c
    }
    if (isRate) rateCols.push(c)
    else if (isQty) qtyCols.push(c)
  }
  qtyCols.sort((a, b) => a - b); rateCols.sort((a, b) => a - b)
  const tiers: { qty: number; rate: number }[] = []
  for (let i = 0; i < Math.min(qtyCols.length, rateCols.length); i++) tiers.push({ qty: qtyCols[i], rate: rateCols[i] })
  return { tiers, total }
}

// ── LABOR table ─────────────────────────────────────────────────────────────
export function extractLabor(grid: Grid): { lines: ParsedLaborLine[]; statedSubtotal: number | null; dropped: number } {
  const header = findLabelCell(grid, n => n === "labor" || n.endsWith(" labor") || n.startsWith("labor"))
  if (!header) return { lines: [], statedSubtotal: null, dropped: 0 }
  // Label-bounded: data ends at 'Total Hours'. firstData is the first numeric
  // row after the header (skips a blank/merged row); the header band excludes it.
  const endRow = findRows(grid, isLabel("total hours")).find(r => r > header.r) ?? grid.length
  const firstData = firstNumericRow(grid, header.r + 1, endRow) ?? header.r + 1
  const { tiers, total } = mapLaborColumns(grid, header.r, firstData - 1)
  const [reg, ot, dt] = tiers
  const roleCol = leftmostTextColumn(grid, firstData, endRow)

  const lines: ParsedLaborLine[] = []
  let dropped = 0
  for (let r = firstData; r < endRow; r++) {
    const role = cellText(at(grid, r, roleCol)).trim()
    const qr = reg ? cellNum(at(grid, r, reg.qty))  : null
    const rr = reg ? cellNum(at(grid, r, reg.rate)) : null
    const qo = ot  ? cellNum(at(grid, r, ot.qty))   : null
    const ro = ot  ? cellNum(at(grid, r, ot.rate))  : null
    const qd = dt  ? cellNum(at(grid, r, dt.qty))   : null
    const rd = dt  ? cellNum(at(grid, r, dt.rate))  : null
    const lt = total != null ? cellNum(at(grid, r, total)) : null
    const allNull = [qr, rr, qo, ro, qd, rd, lt].every(v => v == null)
    if (!role && allNull) continue                       // blank row inside the section
    // Drop rows where every quantity is 0 (or absent).
    if ([qr, qo, qd].every(q => (q ?? 0) === 0)) { dropped++; continue }
    lines.push({
      role: role || null,
      qty_reg: qr, rate_reg: rr != null ? round2(rr) : rr,
      qty_ot: qo,  rate_ot: ro != null ? round2(ro) : ro,
      qty_dt: qd,  rate_dt: rd != null ? round2(rd) : rd,
      lineTotal: lt != null ? round2(lt) : null,
    })
  }
  const subRow = findRows(grid, isLabel("labor subtotal")).find(r => r >= header.r)
  const statedSubtotal = subRow != null ? readLabeledNumber(grid, { r: subRow, c: colOfLabel(grid, subRow, "labor subtotal") }, 12) : null
  return { lines, statedSubtotal: statedSubtotal != null ? round2(statedSubtotal) : null, dropped }
}

// ── MATERIAL / EQUIPMENT table ──────────────────────────────────────────────
export function extractMaterials(grid: Grid): { lines: ParsedMaterialLine[]; statedSubtotal: number | null; dropped: number } {
  const header = findLabelCell(grid, n => n.includes("material") && !n.includes("subtotal"))
  if (!header) return { lines: [], statedSubtotal: null, dropped: 0 }
  const startRow = header.r + 1
  const subRows = findRows(grid, isLabel("materials subtotal")).concat(findRows(grid, isLabel("material subtotal")))
  const endRow = subRows.filter(r => r > header.r).sort((a, b) => a - b)[0] ?? grid.length

  const cols = mapColumns(grid, header.r, 2, [
    { key: "qty",       match: n => n === "qty" || n.includes("quantity") },
    { key: "unit",      match: n => n === "unit" || n === "uom" },
    { key: "unitPrice", match: n => n.includes("unit price") || n.includes("unit cost") || n === "price" || n.includes("$/unit") },
    { key: "note",      match: n => n.includes("description") || n.includes("note") || n.includes("ref") },
    { key: "total",     match: n => n === "total" || n.includes("line total") || n.includes("amount") || n.includes("ext") },
  ])
  const itemCol = leftmostTextColumn(grid, startRow, endRow)

  const lines: ParsedMaterialLine[] = []
  let dropped = 0
  for (let r = startRow; r < endRow; r++) {
    const item = cellText(at(grid, r, itemCol)).trim()
    const qty = cols.qty != null ? cellNum(at(grid, r, cols.qty)) : null
    const unit = cols.unit != null ? cellText(at(grid, r, cols.unit)).trim() : ""
    const unitPrice = cols.unitPrice != null ? cellNum(at(grid, r, cols.unitPrice)) : null
    const note = cols.note != null ? cellText(at(grid, r, cols.note)).trim() : ""
    const lt = cols.total != null ? cellNum(at(grid, r, cols.total)) : null
    const allNull = [qty, unitPrice, lt].every(v => v == null) && !item
    if (allNull) continue
    // Drop rows where qty is 0 (or absent) AND no line total — pure spacer/blank.
    if ((qty ?? 0) === 0 && (lt ?? 0) === 0 && !unitPrice) { dropped++; continue }
    lines.push({
      item: item || null,
      qty,
      unit: unit || null,
      unit_price: unitPrice != null ? round2(unitPrice) : unitPrice,
      note: note || null,
      lineTotal: lt != null ? round2(lt) : null,
    })
  }
  const subRow = endRow < grid.length ? endRow : findRows(grid, isLabel("materials subtotal"))[0]
  const statedSubtotal = subRow != null ? readLabeledNumber(grid, { r: subRow, c: colOfLabel(grid, subRow, "material") }, 12) : null
  return { lines, statedSubtotal: statedSubtotal != null ? round2(statedSubtotal) : null, dropped }
}

// Column index of the cell in `row` whose normalized text includes `needle`.
function colOfLabel(grid: Grid, row: number, needle: string): number {
  const r = grid[row] ?? []
  for (let c = 0; c < r.length; c++) {
    const t = cellText(at(grid, row, c))
    if (t && normLabel(t).includes(needle)) return c
  }
  return 0
}

// ── stated pricing from cover + backup ──────────────────────────────────────
function numberByLabel(grid: Grid, match: (n: string) => boolean, span = 10): number | null {
  const coord = findLabelCell(grid, match)
  if (!coord) return null
  const n = readLabeledNumber(grid, coord, span)
  return n != null ? round2(n) : null
}

export interface CoverFields {
  pcoNumberRaw: string | null
  pcoNumber: string | null
  project: string | null
  dateISO: string | null
  dateVolatileCached: string | null
  title: string | null
  descriptionOfWork: string | null
  scheduleImpactDays: number | null
  signerName: string | null
  signerTitle: string | null
  cover: Pick<StatedPricing, "coverLabor" | "coverMaterials" | "coverSubcontractor" | "coverFee" | "coverTextura" | "coverBond" | "coverTotal">
}

export function extractCover(grid: Grid): CoverFields {
  const pco = extractPcoNumber(grid)
  const project = labelText(grid, isLabel("project"))
  const date = readLabeledDate(grid)
  const title = labelText(grid, isExact("title", "pco title", "subject"))
  const descriptionOfWork = labelText(grid, isLabel("description"))
  const scheduleImpactDays = numberByLabel(grid, isLabel("schedule"), 8)

  // Signer: prefer an explicit Sincerely block; fall back to name/title labels.
  const { name: signerName, title: signerTitle } = extractSigner(grid)

  // Cover pricing summary (TOTAL must be the standalone "TOTAL", not a subtotal).
  const cover = {
    coverLabor: numberByLabel(grid, n => n.includes("labor") && !n.includes("subtotal") && !n.includes("total hours")),
    coverMaterials: numberByLabel(grid, n => n.includes("material")),
    coverSubcontractor: numberByLabel(grid, n => n.includes("subcontractor") || n === "sub"),
    // Fee must NOT swallow the "Textura Fee" line (it also contains "fee").
    coverFee: numberByLabel(grid, n => (n === "fee" || (n.includes("fee") && !n.includes("%"))) && !n.includes("textura")),
    coverTextura: numberByLabel(grid, n => n.includes("textura")),
    coverBond: numberByLabel(grid, isLabel("bond")),
    coverTotal: numberByLabel(grid, isExact("total", "grand total", "total amount", "pco total")),
  }
  return {
    pcoNumberRaw: pco.raw, pcoNumber: pco.normalized,
    project, dateISO: date.iso, dateVolatileCached: date.volatileCached,
    title, descriptionOfWork, scheduleImpactDays,
    signerName, signerTitle, cover,
  }
}

function labelText(grid: Grid, match: (n: string) => boolean, span = 8): string | null {
  const coord = findLabelCell(grid, match)
  if (!coord) return null
  const v = readLabeledText(grid, coord, span).trim()
  return v || null
}

function extractSigner(grid: Grid): { name: string | null; title: string | null } {
  const explicitName = labelText(grid, isExact("name", "signed by", "by", "submitted by", "from"))
  const explicitTitle = labelText(grid, isExact("title", "role")) // note: cover "Title" may be the PCO title; only trust near a signer
  const sincerely = findLabelCell(grid, isLabel("sincerely"))
  if (sincerely) {
    // First two non-empty rows below "Sincerely," in the same column-ish region.
    const lines: string[] = []
    for (let r = sincerely.r + 1; r <= sincerely.r + 6 && lines.length < 2; r++) {
      const row = grid[r] ?? []
      const txt = row.map(cellText).find(t => t && t.trim() !== "")
      if (txt && !/^x+$|^_+$/.test(txt.trim())) lines.push(txt.trim())
    }
    if (lines.length) return { name: lines[0] ?? explicitName, title: lines[1] ?? null }
  }
  return { name: explicitName, title: explicitName && explicitTitle && explicitTitle !== explicitName ? explicitTitle : null }
}

export interface BackupFields {
  pcoNumberRaw: string | null
  pcoNumber: string | null
  jobNumber: string | null
  dateISO: string | null
  dateVolatileCached: string | null
  labor: ParsedLaborLine[]
  materials: ParsedMaterialLine[]
  backup: Pick<StatedPricing, "backupLaborSubtotal" | "backupMaterialsSubtotal" | "backupOhpAmount" | "backupGrandTotal">
  dropped: number
}

export function extractBackup(grid: Grid): BackupFields {
  const pco = extractPcoNumber(grid)
  // 'THP Job #:' normalizes to 'thp job' (the # is stripped), so match on 'job'.
  const jobNumber = labelText(grid, n => n.includes("job") || n.includes("project no") || n.includes("project #"))
  const date = readLabeledDate(grid)
  const labor = extractLabor(grid)
  const materials = extractMaterials(grid)
  const backup = {
    backupLaborSubtotal: labor.statedSubtotal,
    backupMaterialsSubtotal: materials.statedSubtotal,
    backupOhpAmount: numberByLabel(grid, n => n.includes("oh&p") || n.includes("oh & p") || n.includes("overhead")),
    backupGrandTotal: numberByLabel(grid, isExact("grand total")),
  }
  return {
    pcoNumberRaw: pco.raw, pcoNumber: pco.normalized,
    jobNumber, dateISO: date.iso, dateVolatileCached: date.volatileCached,
    labor: labor.lines, materials: materials.lines, backup,
    dropped: labor.dropped + materials.dropped,
  }
}

// ── reconcile: derive OH&P/Fee fractions, recompute totals, run integrity ────
export function reconcile(
  labor: ParsedLaborLine[],
  materials: ParsedMaterialLine[],
  stated: StatedPricing,
): { computed: ComputedPricing; flags: PcoFlag[] } {
  const flags: PcoFlag[] = []

  const laborInputs = labor.map(l => ({ qty_reg: l.qty_reg, rate_reg: l.rate_reg, qty_ot: l.qty_ot, rate_ot: l.rate_ot, qty_dt: l.qty_dt, rate_dt: l.rate_dt }))
  const materialInputs = materials.map(m => ({ qty: m.qty, unit_price: m.unit_price }))
  const laborSubtotal = round2(laborInputs.reduce((s, l) => s + laborLineTotal(l), 0))
  const materialsSubtotal = round2(materialInputs.reduce((s, m) => s + materialLineTotal(m), 0))
  const subcontractor = round2(stated.coverSubcontractor ?? 0)

  // OH&P stored as percent of (labor + materials). Derive from the backup amount.
  const ohpBase = round2(laborSubtotal + materialsSubtotal)
  const ohpAmount = stated.backupOhpAmount ?? 0
  const ohpPercent = ohpBase > 0 && ohpAmount ? round4(ohpAmount / ohpBase) : (ohpAmount ? null : 0)

  // Fee stored as percent of pre-fee total (labor + materials + OH&P + sub).
  const preFee = round2(laborSubtotal + materialsSubtotal + round2(ohpAmount) + subcontractor)
  const feeAmount = stated.coverFee ?? 0
  const feePercent = preFee > 0 && feeAmount ? round4(feeAmount / preFee) : (feeAmount ? null : 0)

  // Textura is a flat cover-summary fee (not derived from lines). Folding it into
  // the computed grand total closes the small near-constant gap that THP cover
  // totals carry over the line-derived subtotals.
  const texturaFee = round2(stated.coverTextura ?? 0)

  const totals = computePcoTotals(laborInputs, materialInputs, subcontractor ? [{ amount: subcontractor }] : [], ohpPercent, feePercent, texturaFee)
  const computed: ComputedPricing = {
    laborSubtotal, materialsSubtotal, ohpPercent, feePercent, texturaFee, subcontractor, total: totals.grandTotal,
  }

  // Integrity: recomputed vs stated (±$0.05).
  pushMismatch(flags, "Labor subtotal", laborSubtotal, stated.backupLaborSubtotal ?? stated.coverLabor)
  pushMismatch(flags, "Materials subtotal", materialsSubtotal, stated.backupMaterialsSubtotal ?? stated.coverMaterials)
  pushMismatch(flags, "Total", totals.grandTotal, stated.coverTotal ?? null)

  // Bond has no TuttoHQ model slot — a non-zero bond can't be represented.
  if (stated.coverBond != null && Math.abs(stated.coverBond) > PRICE_TOLERANCE) {
    flags.push({ code: "unsupported_value", field: "Bond", message: `Bond of ${stated.coverBond} has no field in TuttoHQ and is not imported. Resolve before committing.`, stated: stated.coverBond })
  }
  return { computed, flags }
}

function pushMismatch(flags: PcoFlag[], field: string, computed: number, stated: number | null) {
  if (stated == null) return
  if (Math.abs(round2(computed) - round2(stated)) > PRICE_TOLERANCE) {
    flags.push({ code: "math_mismatch", field, message: `${field}: computed ${computed.toFixed(2)} ≠ stated ${stated.toFixed(2)}`, computed: round2(computed), stated: round2(stated) })
  }
}

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000
