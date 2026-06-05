// Structural diff between the user's THP template and our generated sample.
// Catches regressions a screenshot can't see: missing formulas, off-by-one
// column counts, wrong helper cells, autofilter range, frozen-pane target.

import ExcelJS from "exceljs"

const TEMPLATE = "C:\\Users\\jacei_7431w1\\Downloads\\Submittal_Log.xlsx"
const SAMPLE   = "C:\\Users\\jacei_7431w1\\submittal-library\\scripts\\sample-thp-log.xlsx"

async function load(file) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  return wb.worksheets[0]
}

const tmpl = await load(TEMPLATE)
const sample = await load(SAMPLE)

function describe(ws, name) {
  return {
    name,
    rows: ws.rowCount,
    cols: ws.columnCount,
    view: ws.views?.[0],
    autoFilter: ws.autoFilter,
    merges: ws.model?.merges ?? [],
    title: ws.getCell("A1").value,
    titleFont: ws.getCell("A1").font,
    headerFontA3: ws.getCell("A3").font,
    headerAlignA3: ws.getCell("A3").alignment,
    headerC3: { value: ws.getCell("C3").value, align: ws.getCell("C3").alignment },
    headerF3: ws.getCell("F3").value,
    headerG3: ws.getCell("G3").value,
    apprFormulaJ4: ws.getCell("J4").formula,
    lateFormulaL4: ws.getCell("L4").formula,
    helperS6:  { val: ws.getCell("S6").value,  formula: ws.getCell("S6").formula },
    helperS24: { val: ws.getCell("S24").value, formula: ws.getCell("S24").formula },
    helperR6:  ws.getCell("R6").value,
    helperR24: ws.getCell("R24").value,
    helperP24: ws.getCell("P24").value,
  }
}

const td = describe(tmpl, "TEMPLATE")
const sd = describe(sample, "SAMPLE")

console.log("=== STRUCTURAL DIFF ===\n")
for (const key of Object.keys(td)) {
  const a = JSON.stringify(td[key])
  const b = JSON.stringify(sd[key])
  const match = a === b ? "✓" : "✗"
  console.log(`${match} ${key}`)
  if (a !== b) {
    console.log(`    TEMPLATE: ${a}`)
    console.log(`    SAMPLE:   ${b}`)
  }
}

// Column widths comparison
console.log("\n=== COLUMN WIDTHS (cols 1-14) ===")
for (let c = 1; c <= 14; c++) {
  const tw = tmpl.getColumn(c).width
  const sw = sample.getColumn(c).width
  const ok = (tw == null && sw == null) || Math.abs((tw ?? 0) - (sw ?? 0)) < 0.5
  console.log(`  col ${String.fromCharCode(64+c)}: template=${tw ?? "—"}  sample=${sw ?? "—"}  ${ok ? "✓" : "✗"}`)
}

// Sample row 4 fill verification
console.log("\n=== SAMPLE ROW 4 FILLS (cols 1-14) ===")
for (let c = 1; c <= 14; c++) {
  const f = sample.getRow(4).getCell(c).fill?.fgColor?.argb
  console.log(`  ${String.fromCharCode(64+c)}4: ${f ?? "—"}`)
}

console.log("\n=== SAMPLE HEADER ROW 3 (cols 1-14) ===")
for (let c = 1; c <= 14; c++) {
  const cell = sample.getRow(3).getCell(c)
  console.log(`  ${cell.address}: "${cell.value}" font=${JSON.stringify(cell.font)} align=${JSON.stringify(cell.alignment)}`)
}
