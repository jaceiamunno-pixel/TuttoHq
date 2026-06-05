// THP-template Excel smoke test. Generates a sample .xlsx that exercises the
// same layout + style + formula calls as
// src/app/dashboard/_shared/excel-export.ts, so we can sanity-check the output
// without spinning up the dev server. Writes scripts/sample-thp-log.xlsx.
//
// Usage: node scripts/test-thp-export.mjs

import ExcelJS from "exceljs"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Mirror src/app/dashboard/_shared/csi.ts SECTION_PALETTE_HEX_THP exactly.
const SECTION_PALETTE_HEX_THP = [
  "FFFFF2CC", "FFDEEBF7", "FFE2EFDA", "FFFCE4D6", "FFEDEDED",
  "FFF4CCCC", "FFD9E1F2", "FFFFF4D6", "FFE4DFEC", "FFD0E0E3",
  "FFFFE2CC", "FFD9EAD3", "FFF9CB9C", "FFCFE2F3", "FFEAD1DC",
  "FFFFF8B0", "FFD5E8D4", "FFF8CECC", "FFDAE8FC", "FFE1D5E7",
  "FFF5F5DC", "FFC5E1A5",
]

const THIN_BORDER = {
  top:    { style: "thin", color: { argb: "FFD0D0D0" } },
  left:   { style: "thin", color: { argb: "FFD0D0D0" } },
  bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
  right:  { style: "thin", color: { argb: "FFD0D0D0" } },
}

const STATUS_FALLBACK = { bg: "FFF3F4F6", fg: "FF6B7280" }
const STATUS_FILL = {
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

const HELPER_NOW_ROW = 1
const HELPER_CUTOFF_ROW = 2
const HELPER_CUTOFF_REF = `$S$${HELPER_CUTOFF_ROW}`
const BUFFER_ROWS = 50

function deriveCompanyShort(name) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ""
  if (words.length >= 2) return words.map(w => w[0].toUpperCase()).join("")
  return words[0].toUpperCase().slice(0, 8)
}

function sectionColorMapTHP(codes) {
  const map = new Map()
  let next = 0
  for (const raw of codes) {
    const code = raw ?? "—"
    if (!map.has(code)) {
      map.set(code, next % SECTION_PALETTE_HEX_THP.length)
      next++
    }
  }
  return map
}

function buildColumns(short) {
  return [
    { header: "SUBMITTAL #",                width: 19.6 },
    { header: "SPECIFICATION #",            width: 25.3 },
    { header: "DESCRIPTION",                width: 59.2 },
    { header: "TYPE OF SUBM.",              width: 24.6 },
    { header: "VENDOR",                     width: 27.3 },
    { header: `${short} RECEIVED DATE`,     width: 25.7 },
    { header: `${short} TO A/E DATE`,       width: 25.7 },
    { header: "RETURNED FROM A/E DATE",     width: 25.7 },
    { header: "RETURNED TO SUB DATE",       width: 25.7 },
    { header: "APPROVAL TIME (DAYS)",       width: 25.7 },
    { header: "STATUS",                     width: 26.0 },
    { header: "LATE / ON TIME",             width: 23.4 },
    { header: "SOURCE",                     width: 12   },
    { header: "ACTIONS",                    width: 10   },
  ]
}

function parseDate(d) {
  if (!d) return null
  const [y, m, day] = d.split("-").map(Number)
  return new Date(y, m - 1, day)
}

// Sample data spanning multiple sections so banding is obvious. Description
// values are the cleaned project_item_name shape (post-backfill 615ea05) -- no
// "– <type>" append, since the TYPE OF SUBM. column carries that.
const sampleRows = [
  { seq: 1,  csi: "06 10 00", file: "Rough Carpentry",                        type: "Product Data",  vendor: "Acme Lumber",              rec: "2026-04-12", toAE: "2026-04-14", retAE: "2026-04-26", retSub: "2026-04-27", status: "Approved",               hasSource: true,  hasFile: true },
  { seq: 1,  csi: "06 10 00", file: "Rough Carpentry",                        type: "Certification", vendor: "Acme Lumber",              rec: "2026-04-12", toAE: "2026-04-14", retAE: "2026-04-26", retSub: "2026-04-27", status: "Approved",               hasSource: true,  hasFile: true },
  { seq: 2,  csi: "07 46 46", file: "Fiber Cement Siding",                    type: "Product Data",  vendor: "ClapBoard Co.",            rec: "2026-04-15", toAE: "2026-04-16", retAE: "2026-04-29", retSub: "2026-04-30", status: "Approved",               hasSource: true,  hasFile: true },
  { seq: 2,  csi: "07 46 46", file: "Fiber Cement Siding",                    type: "Shop Drawing",  vendor: "ClapBoard Co.",            rec: "2026-04-15", toAE: "2026-04-16", retAE: null,         retSub: null,         status: "Under Review",           hasSource: true,  hasFile: true },
  { seq: 3,  csi: "07 81 00", file: "Applied Fire Protection",                type: "Product Data",  vendor: "FlameStop LLC",            rec: "2026-04-20", toAE: "2026-04-21", retAE: null,         retSub: null,         status: "Revise and Resubmit",    hasSource: true,  hasFile: true },
  { seq: 4,  csi: "07 42 13", file: "Metal Wall Panels",                      type: "Shop Drawing",  vendor: "Panelcraft",               rec: "2026-04-22", toAE: "2026-04-23", retAE: "2026-05-08", retSub: "2026-05-09", status: "Rejected",               hasSource: false, hasFile: true },
  { seq: 5,  csi: "07 92 00", file: "Joint Sealants",                         type: "Product Data",  vendor: "Sealtech Industries",      rec: "2026-04-25", toAE: "2026-04-26", retAE: "2026-05-04", retSub: "2026-05-05", status: "Approved with Comments", hasSource: true,  hasFile: true },
  { seq: 6,  csi: "10 11 01", file: "Visual Display Boards",                  type: "Product Data",  vendor: "BoardWorks",               rec: "2026-04-28", toAE: null,         retAE: null,         retSub: null,         status: "Received",               hasSource: true,  hasFile: true },
  { seq: 7,  csi: "10 14 00", file: "Signage",                                type: "Product Data",  vendor: "Letterpress Signs",        rec: "2026-05-01", toAE: "2026-05-02", retAE: "2026-05-09", retSub: "2026-05-10", status: "Approved",               hasSource: true,  hasFile: true },
  { seq: 8,  csi: "10 21 13", file: "Toilet Compartments",                    type: "Shop Drawing",  vendor: "Restroom Partitions Inc.", rec: "2026-05-04", toAE: "2026-05-05", retAE: null,         retSub: null,         status: "Needs Review",           hasSource: false, hasFile: true },
  { seq: 9,  csi: "23 31 00", file: "HVAC Ductwork Coordination Drawings",    type: "Shop Drawing",  vendor: "Mountain Mechanical",      rec: "2026-05-08", toAE: "2026-05-09", retAE: null,         retSub: null,         status: "Transmitted",            hasSource: true,  hasFile: true },
  { seq: 10, csi: "26 05 19", file: "MC Cable",                               type: "Product Data",  vendor: "Powerline Electric",       rec: "2026-05-10", toAE: "2026-05-11", retAE: "2026-05-18", retSub: "2026-05-19", status: "Sent to Sub",            hasSource: true,  hasFile: true },
]

const gcName = "Tomlinson Hawley Patterson"
const projectName = "Acme Tower Renovation"

const companyDisplay = (gcName ?? "").trim() || projectName.trim()
const titleText = companyDisplay ? `${companyDisplay} Submittal Log` : "Submittal Log"
const companyShort = deriveCompanyShort(companyDisplay) || "GC"

const columns = buildColumns(companyShort)
const lastDataCol = columns.length
const lastThpCol = 12

const wb = new ExcelJS.Workbook()
wb.creator = "TuttoHQ"
wb.created = new Date()
const ws = wb.addWorksheet("Sheet1")

ws.columns = columns.map(c => ({ width: c.width }))

ws.mergeCells(1, 1, 2, lastThpCol)
const titleCell = ws.getCell(1, 1)
titleCell.value = titleText
titleCell.font = { name: "Arial", size: 18 }
titleCell.alignment = { horizontal: "center", vertical: "middle", wrapText: false }
ws.getRow(1).height = 24
ws.getRow(2).height = 24

const headerRow = ws.getRow(3)
headerRow.height = 31.2
columns.forEach((col, i) => {
  const cell = headerRow.getCell(i + 1)
  cell.value = col.header
  cell.font = { name: "Arial", size: 12, bold: true }
  cell.alignment = i === 2
    ? { horizontal: "left", vertical: "top", wrapText: true }
    : { horizontal: "center", vertical: "middle", wrapText: true }
  cell.border = THIN_BORDER
})

const colorIdx = sectionColorMapTHP(sampleRows.map(r => r.csi))
const rowBgFor = sec => SECTION_PALETTE_HEX_THP[colorIdx.get(sec ?? "—") ?? 0]

const firstDataRow = 4
sampleRows.forEach((s, i) => {
  const r = firstDataRow + i
  const row = ws.getRow(r)
  const rowBg = rowBgFor(s.csi)

  row.getCell(1).value  = s.seq
  row.getCell(2).value  = s.csi
  row.getCell(3).value  = s.file
  row.getCell(4).value  = s.type
  row.getCell(5).value  = s.vendor
  row.getCell(6).value  = parseDate(s.rec)
  row.getCell(7).value  = parseDate(s.toAE)
  row.getCell(8).value  = parseDate(s.retAE)
  row.getCell(9).value  = parseDate(s.retSub)
  row.getCell(10).value = { formula: `IF(H${r}>0,H${r}-G${r}," ")` }
  row.getCell(11).value = s.status
  row.getCell(12).value = {
    formula: `IF(AND(G${r}<${HELPER_CUTOFF_REF},G${r}>1,OR(K${r}="Under Review",K${r}="Revise and Resubmit")),"Late","Not Late")`,
  }
  row.getCell(13).value = s.hasSource ? "Spec book" : ""

  row.height = 17.4
  row.font = { name: "Calibri", size: 12 }

  for (let c = 1; c <= lastDataCol; c++) {
    const cell = row.getCell(c)
    cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } }
    cell.border = THIN_BORDER
  }
  for (let c = 6; c <= 9; c++) {
    row.getCell(c).numFmt = "mmm d, yyyy"
  }

  row.getCell(3).font = { name: "Calibri", size: 13, bold: true }

  const fill = STATUS_FILL[s.status] ?? STATUS_FALLBACK
  const statusCell = row.getCell(11)
  statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill.bg } }
  statusCell.font = { name: "Calibri", size: 12, bold: true, color: { argb: fill.fg } }
  statusCell.alignment = { vertical: "middle", horizontal: "center" }

  if (s.hasFile) {
    const oc = row.getCell(14)
    oc.value = { text: "Open", hyperlink: `https://tuttohq.com/api/download/sample-${s.seq}`, tooltip: s.file }
    oc.font = { name: "Calibri", size: 12, color: { argb: "FF1D4ED8" }, underline: true }
    oc.alignment = { vertical: "middle", horizontal: "center" }
  }
})

const lastDataRow = firstDataRow + sampleRows.length - 1
const lastRow = lastDataRow + BUFFER_ROWS
for (let r = lastDataRow + 1; r <= lastRow; r++) {
  const row = ws.getRow(r)
  row.getCell(10).value = { formula: `IF(H${r}>0,H${r}-G${r}," ")` }
  row.getCell(12).value = {
    formula: `IF(AND(G${r}<${HELPER_CUTOFF_REF},G${r}>1,OR(K${r}="Under Review",K${r}="Revise and Resubmit")),"Late","Not Late")`,
  }
  row.height = 17.4
  row.font = { name: "Calibri", size: 12 }
  for (let c = 1; c <= lastDataCol; c++) {
    row.getCell(c).border = THIN_BORDER
  }
  for (let c = 6; c <= 9; c++) {
    row.getCell(c).numFmt = "mmm d, yyyy"
  }
}

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

ws.getColumn(16).width = 34.6
ws.getColumn(18).width = 15.7
ws.getColumn(19).width = 10.7

ws.views = [{
  state: "frozen",
  xSplit: 0,
  ySplit: 3,
  topLeftCell: "A4",
  zoomScale: 88,
  activeCell: "A4",
  showGridLines: true,
}]
ws.autoFilter = {
  from: { row: 3, column: 1 },
  to:   { row: lastRow, column: lastDataCol },
}

const buf = await wb.xlsx.writeBuffer()
const out = join(__dirname, "sample-thp-log.xlsx")
writeFileSync(out, Buffer.from(buf))
console.log("Wrote", out, `(${buf.byteLength} bytes, ${sampleRows.length} data rows + ${BUFFER_ROWS} buffer)`)
console.log("Title:", titleText)
console.log("Company short:", companyShort)
