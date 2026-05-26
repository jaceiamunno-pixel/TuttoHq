// Client-side Excel export for the Submittal Log.
//
// Renders the user's *currently filtered + sorted* view as a styled .xlsx that
// matches the THP (Tomlinson Hawley Patterson) Submittal Log template, which
// is the de-facto industry format the user requested. ExcelJS is
// dynamic-imported so the ~600 KB library stays out of the main route bundle
// until the user clicks Export.
//
// Layout (matches Submittal_Log.xlsx reference exactly):
//   row 1-2  → merged A1:L2 title  ("<GC Name> Submittal Log", Arial 48)
//   row 3    → header (Arial 12 bold, ALL CAPS)
//   row 4+   → data rows, tinted by csi_section via SECTION_PALETTE_HEX_THP
//   cols P/R/S → helper cells driving the Late/On-Time formula

import type { SubmittalRecord, SubcontractorRow, SupplierRow } from "./types"
import { SECTION_PALETTE_HEX_THP } from "./csi"

const STATUS_FALLBACK = { bg: "FFF3F4F6", fg: "FF6B7280" }  // gray-100 / gray-500
const STATUS_FILL: Record<string, { bg: string; fg: string }> = {
  "Received":               { bg: "FFDBEAFE", fg: "FF1D4ED8" },
  "Sent to Sub":            STATUS_FALLBACK,
  "Under Review":           { bg: "FFFEF3C7", fg: "FFB45309" },
  "Approved":               { bg: "FFDCFCE7", fg: "FF15803D" },
  "Approved with Comments": { bg: "FFDBEAFE", fg: "FF1D4ED8" },
  "Rejected":               { bg: "FFFEE2E2", fg: "FFB91C1C" },
  "Revise and Resubmit":    { bg: "FFFEF3C7", fg: "FFB45309" },
  "Needs Review":           { bg: "FFFEF3C7", fg: "FFB45309" },
  "Transmitted":            { bg: "FFF3E8FF", fg: "FF7E22CE" },
}

// Column widths copied from the THP template (A-L), plus sensible widths for
// our two added columns (M Source, N Actions).
interface ColDef { header: string; width: number }
function buildColumns(companyShort: string): ColDef[] {
  return [
    { header: "SUBMITTAL #",                width: 19.6 },
    { header: "SPECIFICATION #",            width: 25.3 },
    { header: "DESCRIPTION",                width: 59.2 },
    { header: "TYPE OF SUBM.",              width: 24.6 },
    { header: "VENDOR",                     width: 27.3 },
    { header: `${companyShort} RECEIVED DATE`, width: 25.7 },
    { header: `${companyShort} TO A/E DATE`,   width: 25.7 },
    { header: "RETURNED FROM A/E DATE",     width: 25.7 },
    { header: "RETURNED TO SUB DATE",       width: 25.7 },
    { header: "APPROVAL TIME (DAYS)",       width: 25.7 },
    { header: "STATUS",                     width: 26.0 },
    { header: "LATE / ON TIME",             width: 23.4 },
    { header: "SOURCE",                     width: 12   },
    { header: "ACTIONS",                    width: 10   },
  ]
}

// 1-based column indices.
const COL_SUBM   = 1
const COL_SPEC   = 2
const COL_TYPE   = 4
const COL_REC    = 6
const COL_TO_AE  = 7
const COL_RET_AE = 8
const COL_RET_SUB = 9
const COL_APPR   = 10
const COL_STATUS = 11
const COL_LATE   = 12
const COL_SOURCE = 13
const COL_OPEN   = 14

// Helper cell layout — see /scripts/thp-template-report.txt.
const HELPER_NOW_ROW       = 6   // S6  = NOW()
const HELPER_CUTOFF_ROW    = 24  // S24 = S6 - 14  (today minus 14 days)
const HELPER_CUTOFF_REF    = `$S$${HELPER_CUTOFF_ROW}`

// Extra empty rows appended after the last data row, pre-filled with formulas
// so they activate the moment a user fills in date columns.
const BUFFER_ROWS = 50

function vendorLabel(
  s: SubmittalRecord,
  subs: SubcontractorRow[],
  suppliers: SupplierRow[],
): string {
  if (s.vendor_subcontractor_id)
    return subs.find(v => v.id === s.vendor_subcontractor_id)?.company_name ?? ""
  if (s.vendor_supplier_id)
    return suppliers.find(v => v.id === s.vendor_supplier_id)?.company_name ?? ""
  return ""
}

function parseDate(d: string | null): Date | null {
  if (!d) return null
  const [y, m, day] = d.split("-").map(Number)
  if (!y || !m || !day) return null
  return new Date(y, m - 1, day)
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "project"
}

// Derive a short company label for column-header prefixes (e.g.
// "Tomlinson Hawley Patterson" → "THP"). Falls back to uppercased first word.
function deriveCompanyShort(companyName: string): string {
  const words = companyName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ""
  if (words.length >= 2) return words.map(w => w[0]!.toUpperCase()).join("")
  return words[0]!.toUpperCase().slice(0, 8)
}

// Section → palette index. THP template assigns colors in order of first
// appearance in the data; we match that so the visual banding mirrors the
// reference file exactly.
function sectionColorMapTHP(sectionCodes: (string | null | undefined)[]): Map<string, number> {
  const map = new Map<string, number>()
  let next = 0
  for (const raw of sectionCodes) {
    const code = raw ?? "—"
    if (!map.has(code)) {
      map.set(code, next % SECTION_PALETTE_HEX_THP.length)
      next++
    }
  }
  return map
}

export interface ExportSubmittalLogArgs {
  rows: SubmittalRecord[]
  projectName: string
  /** From projects.gc_name. Drives the title row + header/helper company labels. */
  gcName: string | null
  vendorSubs: SubcontractorRow[]
  vendorSuppliers: SupplierRow[]
  appOrigin: string
  groupedBySection: boolean
  isSearchMode: boolean
  searchQuery: string | null
}

export async function exportSubmittalLogToExcel(args: ExportSubmittalLogArgs): Promise<void> {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  wb.creator = "TuttoHQ"
  wb.created = new Date()

  // Title / company name resolution:
  //   1. gc_name (preferred — the submittal log is the GC's log)
  //   2. project name fallback
  //   3. literal "Submittal Log" if neither is set
  const companyDisplay = (args.gcName ?? "").trim() || args.projectName.trim()
  const titleText = companyDisplay
    ? `${companyDisplay} Submittal Log`
    : "Submittal Log"
  const companyShort = deriveCompanyShort(companyDisplay) || "GC"

  const columns = buildColumns(companyShort)
  const lastDataCol = columns.length          // 14 (A..N)
  const lastThpCol  = 12                      // L — template's autofilter range
  const ws = wb.addWorksheet("Sheet1")

  // ── 1) Column widths ─────────────────────────────────────────────────────
  ws.columns = columns.map(c => ({ width: c.width }))

  // ── 2) Title row (A1:L2 merged) ─────────────────────────────────────────
  ws.mergeCells(1, 1, 2, lastThpCol)
  const titleCell = ws.getCell(1, 1)
  titleCell.value = titleText
  titleCell.font = { name: "Arial", size: 48 }
  titleCell.alignment = { horizontal: "center", vertical: "middle", wrapText: false }
  ws.getRow(1).height = 60
  ws.getRow(2).height = 60

  // ── 3) Header row (row 3) ───────────────────────────────────────────────
  const headerRow = ws.getRow(3)
  headerRow.height = 31.2
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = col.header
    cell.font = { name: "Arial", size: 12, bold: true }
    cell.alignment = i === 2 // DESCRIPTION column = left/top in template
      ? { horizontal: "left", vertical: "top", wrapText: true }
      : { horizontal: "center", vertical: "middle", wrapText: true }
  })

  // ── 4) Section-tint colour map (THP palette, by appearance order) ───────
  const colorIdx = sectionColorMapTHP(args.rows.map(r => r.csi_section))
  const rowBgFor = (sec: string | null) =>
    SECTION_PALETTE_HEX_THP[colorIdx.get(sec ?? "—") ?? 0]

  // ── 5) Data rows (starting row 4) ───────────────────────────────────────
  const firstDataRow = 4
  args.rows.forEach((s, i) => {
    const r = firstDataRow + i
    const row = ws.getRow(r)
    const vendor = vendorLabel(s, args.vendorSubs, args.vendorSuppliers)
    const status = s.review_status ?? "Received"
    const rowBg  = rowBgFor(s.csi_section)

    row.getCell(COL_SUBM).value    = s.submittal_seq ?? ""
    row.getCell(COL_SPEC).value    = s.csi_section   ?? ""
    row.getCell(3).value           = s.file_name
    row.getCell(COL_TYPE).value    = s.submittal_type ?? ""
    row.getCell(5).value           = vendor
    row.getCell(COL_REC).value     = parseDate(s.received_date)
    row.getCell(COL_TO_AE).value   = parseDate(s.sent_to_ae_date)
    row.getCell(COL_RET_AE).value  = parseDate(s.returned_from_ae_date)
    row.getCell(COL_RET_SUB).value = parseDate(s.returned_to_sub_date)
    // Approval Time formula — mirrors the THP template exactly.
    row.getCell(COL_APPR).value    = { formula: `IF(H${r}>0,H${r}-G${r}," ")` }
    row.getCell(COL_STATUS).value  = status
    // Late / On-Time formula — same shape as template, but checks our app's
    // status labels ("Under Review" instead of THP's "A/E Review").
    row.getCell(COL_LATE).value = {
      formula: `IF(AND(G${r}<${HELPER_CUTOFF_REF},G${r}>1,OR(K${r}="Under Review",K${r}="Revise and Resubmit")),"Late","Not Late")`,
    }
    row.getCell(COL_SOURCE).value = s.source === "spec_ingestion" && s.spec_section_id ? "Spec book" : ""

    row.height = 17.4
    row.font = { name: "Calibri", size: 12 }

    // Row tint pass — every cell A..N gets the section pastel.
    for (let c = 1; c <= lastDataCol; c++) {
      row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } }
    }

    // Date columns: format mmm d, yyyy (template has no formatted dates yet,
    // but our app supplies real Date values that need a display format).
    for (let c = COL_REC; c <= COL_RET_SUB; c++) {
      row.getCell(c).numFmt = "mmm d, yyyy"
    }

    // DESCRIPTION (col C) — Calibri 13 bold per template.
    row.getCell(3).font = { name: "Calibri", size: 13, bold: true }

    // STATUS badge — the one deliberate divergence from the template; mirrors
    // the on-screen pill colours so reviewers spot statuses at a glance.
    const fill = STATUS_FILL[status] ?? STATUS_FALLBACK
    const statusCell = row.getCell(COL_STATUS)
    statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill.bg } }
    statusCell.font = { name: "Calibri", size: 12, bold: true, color: { argb: fill.fg } }
    statusCell.alignment = { vertical: "middle", horizontal: "center" }

    // ACTIONS — "Open" hyperlink to /api/download/<id> (auth-checked per req).
    if (s.storage_path) {
      const openCell = row.getCell(COL_OPEN)
      openCell.value = {
        text: "Open",
        hyperlink: `${args.appOrigin}/api/download/${s.id}`,
        tooltip: s.file_name,
      }
      openCell.font = { name: "Calibri", size: 12, color: { argb: "FF1D4ED8" }, underline: true }
      openCell.alignment = { vertical: "middle", horizontal: "center" }
    }
  })

  // ── 6) Buffer rows: blank, but formulas live so they activate on data entry
  const lastDataRow = firstDataRow + args.rows.length - 1
  const lastRow     = Math.max(lastDataRow, firstDataRow - 1) + BUFFER_ROWS
  for (let r = lastDataRow + 1; r <= lastRow; r++) {
    const row = ws.getRow(r)
    row.getCell(COL_APPR).value = { formula: `IF(H${r}>0,H${r}-G${r}," ")` }
    row.getCell(COL_LATE).value = {
      formula: `IF(AND(G${r}<${HELPER_CUTOFF_REF},G${r}>1,OR(K${r}="Under Review",K${r}="Revise and Resubmit")),"Late","Not Late")`,
    }
    row.height = 17.4
    row.font = { name: "Calibri", size: 12 }
    // Date column formatting carries forward so manually entered dates render
    // correctly on first paint.
    for (let c = COL_REC; c <= COL_RET_SUB; c++) {
      row.getCell(c).numFmt = "mmm d, yyyy"
    }
  }

  // ── 7) Helper cells (P/Q/R/S) — drive the Late formula's $S$24 reference
  const tnr = { name: "Times New Roman", size: 11 }
  ws.getCell(`R${HELPER_NOW_ROW}`).value    = "Today"
  ws.getCell(`R${HELPER_NOW_ROW}`).font     = tnr
  ws.getCell(`S${HELPER_NOW_ROW}`).value    = { formula: "NOW()" }
  ws.getCell(`S${HELPER_NOW_ROW}`).font     = tnr
  ws.getCell(`P${HELPER_CUTOFF_ROW}`).value = companyShort
  ws.getCell(`P${HELPER_CUTOFF_ROW}`).font  = { name: "Calibri", size: 11 }
  ws.getCell(`R${HELPER_CUTOFF_ROW}`).value = "Past 2 weeks"
  ws.getCell(`R${HELPER_CUTOFF_ROW}`).font  = tnr
  ws.getCell(`S${HELPER_CUTOFF_ROW}`).value = { formula: `S${HELPER_NOW_ROW}-14` }
  ws.getCell(`S${HELPER_CUTOFF_ROW}`).font  = tnr

  // Helper column widths (P/Q/R/S — match template).
  ws.getColumn(16).width = 34.6  // P
  // Q column default
  ws.getColumn(18).width = 15.7  // R
  ws.getColumn(19).width = 10.7  // S

  // ── 8) Frozen panes (A4) + autofilter ──────────────────────────────────
  ws.views = [{
    state: "frozen",
    xSplit: 0,
    ySplit: 3,
    topLeftCell: "A4",
    zoomScale: 88,
    activeCell: "A4",
  }]
  ws.autoFilter = {
    from: { row: 3, column: 1 },
    to:   { row: lastRow, column: lastDataCol },
  }

  // ── 9) Trigger download ─────────────────────────────────────────────────
  const buf  = await wb.xlsx.writeBuffer()
  const date = new Date().toISOString().slice(0, 10)
  const name = `${sanitizeFileName(args.projectName)}_submittal_log_${date}.xlsx`
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  // groupedBySection / isSearchMode / searchQuery are retained on the args
  // type to preserve the call site, but the THP template has no metadata
  // sheet so they are intentionally unused here.
  void args.groupedBySection
  void args.isSearchMode
  void args.searchQuery
}
