// Programmatic verification of the three Fix-N changes. Confirms:
//   1. Title font is 18, not 48
//   2. ws.views[0].showGridLines === true
//   3. Helpers live at S1/S2/P2 (not S6/S24/P24); P{any data row} is empty
//   4. Actions column N is empty for rows without storage_path

import ExcelJS from "exceljs"
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile("C:\\Users\\jacei_7431w1\\submittal-library\\scripts\\sample-thp-log.xlsx")
const ws = wb.worksheets[0]

console.log("=== FIX 1: title font size ===")
console.log(`  A1 font: ${JSON.stringify(ws.getCell("A1").font)}`)
console.log(`  row 1 height: ${ws.getRow(1).height}`)
console.log(`  row 2 height: ${ws.getRow(2).height}`)

console.log("\n=== FIX 2: gridlines ===")
console.log(`  ws.views[0]: ${JSON.stringify(ws.views?.[0])}`)

console.log("\n=== FIX 3: helper relocation ===")
for (const addr of ["S1", "R1", "P1", "S2", "R2", "P2", "S6", "R6", "S24", "R24", "P24"]) {
  const c = ws.getCell(addr)
  console.log(`  ${addr}: value=${JSON.stringify(c.value)} font=${JSON.stringify(c.font)}`)
}

console.log("\n=== Actions col N — must be empty for rows without storage_path ===")
// Our test data has all 12 rows with hasFile:true so all should have hyperlinks.
// Also check P at data rows (4-15) is empty — no helper leak.
for (let r = 4; r <= 15; r++) {
  const n = ws.getRow(r).getCell(14)
  const p = ws.getRow(r).getCell(16)
  console.log(`  row ${r}: N=${JSON.stringify(n.value)?.slice(0, 60)}  P=${JSON.stringify(p.value)}`)
}
