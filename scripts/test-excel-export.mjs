// Smoke-test for the Excel export. Generates a sample submittal-log .xlsx
// using the same ExcelJS calls + style values as src/app/dashboard/_shared/excel-export.ts,
// so we can sanity-check the output without spinning up the full dev server.
//
// Usage: node scripts/test-excel-export.mjs
// Writes: scripts/sample-submittal-log.xlsx

import ExcelJS from "exceljs"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Mirror src/app/dashboard/_shared/csi.ts — kept in lockstep with the live palettes.
const SECTION_PALETTE_HEX = [
  "FFF8FAFC", "FFEFF6FF", "FFECFDF5", "FFFFFBEB",
  "FFF5F3FF", "FFFFF1F2", "FFECFEFF", "FFF7FEE7",
]
const SECTION_CHIP_HEX = [
  "FFF1F5F9", "FFDBEAFE", "FFD1FAE5", "FFFEF3C7",
  "FFEDE9FE", "FFFFE4E6", "FFCFFAFE", "FFECFCCB",
]
function sectionColorMap(sectionCodes) {
  const distinct = [...new Set(sectionCodes.map(c => c ?? "—"))].sort()
  const map = new Map()
  distinct.forEach((code, i) => map.set(code, i % SECTION_PALETTE_HEX.length))
  return map
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
const LATE_FILL = {
  "Late":    { bg: "FFFEE2E2", fg: "FFB91C1C" },
  "On Time": { bg: "FFDCFCE7", fg: "FF15803D" },
}
const COLUMNS = [
  { header: "Subm. #",         width:  9 },
  { header: "Spec #",          width: 12 },
  { header: "Description",     width: 50 },
  { header: "Type of Subm.",   width: 16 },
  { header: "Vendor",          width: 28 },
  { header: "Received",        width: 13 },
  { header: "To A/E",          width: 13 },
  { header: "Returned A/E",    width: 14 },
  { header: "Returned to Sub", width: 16 },
  { header: "Approval (Days)", width: 14 },
  { header: "Status",          width: 22 },
  { header: "Late / On Time",  width: 14 },
  { header: "Source",          width: 12 },
  { header: "Actions",         width: 10 },
]
const HEADER_FILL = { bg: "FFF8F9FA", fg: "FF64748B" }

// Cover all 9 statuses + a Late/On-Time mix across 8 distinct sections so the
// generated xlsx exercises every color path (8 section pastels, all status
// badge fills, both late states).
const sampleRows = [
  { seq: 1,  csi: "03 30 00", file: "Concrete_Mix_Design_4000psi.pdf",        type: "Product Data",  vendor: "Acme Concrete Co.",     rec: "2026-04-12", toAE: "2026-04-14", retAE: "2026-04-26", retSub: "2026-04-27", status: "Approved",               late: "On Time", hasSource: true,  hasFile: true },
  { seq: 2,  csi: "03 30 00", file: "Rebar_Shop_Drawings_RevB.pdf",            type: "Shop Drawing",  vendor: "Bayview Steel Supply",  rec: "2026-04-15", toAE: "2026-04-16", retAE: null,         retSub: null,         status: "Under Review",           late: "Late",    hasSource: true,  hasFile: true },
  { seq: 3,  csi: "04 22 00", file: "CMU_Block_Samples.pdf",                   type: "Sample",        vendor: "Crestline Masonry",     rec: "2026-04-18", toAE: "2026-04-20", retAE: "2026-04-25", retSub: "2026-04-26", status: "Approved with Comments", late: "On Time", hasSource: true,  hasFile: true },
  { seq: 4,  csi: "05 12 00", file: "Structural_Steel_W14x90_Mill.pdf",        type: "Certification", vendor: "Bayview Steel Supply",  rec: "2026-04-22", toAE: "2026-04-23", retAE: "2026-05-08", retSub: "2026-05-09", status: "Rejected",               late: "Late",    hasSource: false, hasFile: true },
  { seq: 5,  csi: "07 21 00", file: "Insulation_R30_Datasheet.pdf",            type: "Product Data",  vendor: "Thermal Solutions LLC", rec: "2026-04-28", toAE: null,         retAE: null,         retSub: null,         status: "Received",               late: "",        hasSource: true,  hasFile: true },
  { seq: 6,  csi: "08 11 13", file: "HM_Frame_Schedule_2026.pdf",              type: "Shop Drawing",  vendor: "Doorworks Inc.",        rec: "2026-05-02", toAE: "2026-05-03", retAE: "2026-05-12", retSub: "2026-05-12", status: "Revise and Resubmit",    late: "On Time", hasSource: true,  hasFile: true },
  { seq: 7,  csi: "09 51 13", file: "ACT_Ceiling_Tile_Submittal.pdf",          type: "Product Data",  vendor: "Crestline Masonry",     rec: "2026-05-08", toAE: "2026-05-09", retAE: "2026-05-15", retSub: null,         status: "Needs Review",           late: "On Time", hasSource: false, hasFile: true },
  { seq: 8,  csi: "23 31 00", file: "HVAC_Ductwork_Coord.pdf",                 type: "Shop Drawing",  vendor: "Mountain Mechanical",   rec: "2026-05-12", toAE: "2026-05-14", retAE: null,         retSub: null,         status: "Transmitted",            late: "On Time", hasSource: true,  hasFile: true },
  { seq: 9,  csi: "26 05 19", file: "MC_Cable_Submittal.pdf",                  type: "Product Data",  vendor: "Powerline Electric",    rec: "2026-05-14", toAE: "2026-05-15", retAE: "2026-05-22", retSub: "2026-05-23", status: "Approved",               late: "On Time", hasSource: true,  hasFile: true },
  { seq: 10, csi: "31 23 00", file: "Earthwork_Compaction_Report.pdf",         type: "Lab Test",      vendor: "Geotechnical Partners", rec: "2026-04-04", toAE: "2026-04-05", retAE: "2026-04-12", retSub: "2026-04-13", status: "Sent to Sub",            late: "On Time", hasSource: true,  hasFile: true },
]

function parseDate(d) {
  if (!d) return null
  const [y, m, day] = d.split("-").map(Number)
  return new Date(y, m - 1, day)
}
function approvalDays(s) {
  if (!s.toAE || !s.retAE) return null
  const t1 = Date.parse(s.toAE), t2 = Date.parse(s.retAE)
  return Math.round((t2 - t1) / 86_400_000)
}

const wb = new ExcelJS.Workbook()
wb.creator = "TuttoHQ"
wb.created = new Date()
const ws = wb.addWorksheet("Submittal Log", { views: [{ state: "frozen", ySplit: 1 }] })
ws.columns = COLUMNS.map(c => ({ header: c.header, width: c.width }))

const colorIdx = sectionColorMap(sampleRows.map(r => r.csi))
const rowBgFor  = sec => SECTION_PALETTE_HEX[colorIdx.get(sec ?? "—") ?? 0]
const chipBgFor = sec => SECTION_CHIP_HEX[colorIdx.get(sec ?? "—") ?? 0]

const headerRow = ws.getRow(1)
headerRow.height = 22
headerRow.eachCell(cell => {
  cell.font      = { bold: true, size: 9, color: { argb: HEADER_FILL.fg }, name: "Calibri" }
  cell.alignment = { vertical: "middle", horizontal: "left" }
  cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL.bg } }
  cell.border    = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } }
})

for (const s of sampleRows) {
  const days = approvalDays(s)
  const rowBg  = rowBgFor(s.csi)
  const chipBg = chipBgFor(s.csi)
  const row = ws.addRow([
    s.seq, s.csi, s.file, s.type, s.vendor,
    parseDate(s.rec), parseDate(s.toAE), parseDate(s.retAE), parseDate(s.retSub),
    days ?? "", s.status, s.late, s.hasSource ? "Spec book" : "", "",
  ])
  row.height = 18
  row.alignment = { vertical: "middle" }
  row.font = { size: 10, name: "Calibri" }

  // Row tint pass
  for (let c = 1; c <= COLUMNS.length; c++) {
    const cell = row.getCell(c)
    cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } }
    cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } }
  }
  for (const colIdx of [6, 7, 8, 9]) {
    const c = row.getCell(colIdx); c.numFmt = "mmm d, yyyy"; c.alignment = { vertical: "middle", horizontal: "left" }
  }

  // Spec # chip
  const specCell = row.getCell(2)
  specCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: chipBg } }
  specCell.font = { size: 10, name: "Consolas", bold: true, color: { argb: "FF0F172A" } }
  specCell.alignment = { vertical: "middle", horizontal: "left" }

  row.getCell(1).font = { size: 10, name: "Calibri", bold: true, color: { argb: "FF0F172A" } }
  row.getCell(1).alignment = { vertical: "middle", horizontal: "left" }
  row.getCell(4).font = { size: 10, name: "Calibri", color: { argb: "FF64748B" } }
  row.getCell(10).alignment = { vertical: "middle", horizontal: "center" }
  row.getCell(10).font = { size: 10, name: "Calibri", color: { argb: "FF64748B" } }

  // Status badge — overrides row tint
  const sFill = STATUS_FILL[s.status] ?? STATUS_FALLBACK
  const statusCell = row.getCell(11)
  statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: sFill.bg } }
  statusCell.font = { size: 10, name: "Calibri", bold: true, color: { argb: sFill.fg } }
  statusCell.alignment = { vertical: "middle", horizontal: "center" }

  if (s.late) {
    const lf = LATE_FILL[s.late]
    const lc = row.getCell(12)
    lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: lf.bg } }
    lc.font = { size: 10, name: "Calibri", bold: true, color: { argb: lf.fg } }
    lc.alignment = { vertical: "middle", horizontal: "center" }
  }

  if (s.hasFile) {
    const oc = row.getCell(14)
    oc.value = { text: "Open", hyperlink: `https://tuttohq.com/api/download/sample-${s.seq}`, tooltip: s.file }
    oc.font = { size: 10, name: "Calibri", color: { argb: "FF1D4ED8" }, underline: true }
    oc.alignment = { vertical: "middle", horizontal: "center" }
  }
}

ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }

const meta = wb.addWorksheet("Export Info")
meta.columns = [{ width: 22 }, { width: 60 }]
const exportedAt = new Date()
for (const [label, value] of [
  ["Project", "Acme Tower Renovation"],
  ["Exported at", exportedAt.toLocaleString()],
  ["Row count", String(sampleRows.length)],
  ["Grouped by section", "Yes"],
  ["Search filter", "—"],
  ["Source", "TuttoHQ Submittal Log"],
]) {
  const r = meta.addRow([label, value])
  r.getCell(1).font = { bold: true, size: 10, color: { argb: "FF64748B" } }
  r.getCell(2).font = { size: 10, color: { argb: "FF0F172A" } }
}

const buf = await wb.xlsx.writeBuffer()
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const out = join(__dirname, `sample-submittal-log-${stamp}.xlsx`)
writeFileSync(out, Buffer.from(buf))
console.log("Wrote", out, "(" + buf.byteLength + " bytes)")

// ── Programmatic readback verification ───────────────────────────────────────
// Round-trip the file via ExcelJS and assert each row's first cell carries the
// expected section-tint fill, and each status cell carries its badge fill.
const verifyWb = new ExcelJS.Workbook()
await verifyWb.xlsx.readFile(out)
const verifyWs = verifyWb.getWorksheet("Submittal Log")
let fails = 0
sampleRows.forEach((s, i) => {
  const rowIdx = i + 2  // row 1 is the header
  const expectedRow = rowBgFor(s.csi).toUpperCase()
  const expectedChip = chipBgFor(s.csi).toUpperCase()
  const sFill = STATUS_FILL[s.status] ?? STATUS_FALLBACK
  const expectedStatus = sFill.bg.toUpperCase()

  const subCell    = verifyWs.getRow(rowIdx).getCell(1)
  const specCell   = verifyWs.getRow(rowIdx).getCell(2)
  const statusCell = verifyWs.getRow(rowIdx).getCell(11)

  const subFill    = subCell.fill?.fgColor?.argb?.toUpperCase()
  const specFill   = specCell.fill?.fgColor?.argb?.toUpperCase()
  const statusFill = statusCell.fill?.fgColor?.argb?.toUpperCase()

  if (subFill !== expectedRow) {
    console.error(`  row ${rowIdx} subm. cell fill ${subFill ?? "<none>"} != expected ${expectedRow}`)
    fails++
  }
  if (specFill !== expectedChip) {
    console.error(`  row ${rowIdx} spec # cell fill ${specFill ?? "<none>"} != expected ${expectedChip}`)
    fails++
  }
  if (statusFill !== expectedStatus) {
    console.error(`  row ${rowIdx} status cell fill ${statusFill ?? "<none>"} != expected ${expectedStatus}`)
    fails++
  }
})
if (fails === 0) {
  console.log("✓ readback verification passed — row tints, chip tints, and status fills all correct.")
} else {
  console.error(`✗ readback verification failed with ${fails} mismatched cells.`)
  process.exit(1)
}
