import ExcelJS from "exceljs"
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile("C:\\Users\\jacei_7431w1\\submittal-library\\scripts\\sample-thp-log.xlsx")
const ws = wb.worksheets[0]

function describe(addr) {
  const c = ws.getCell(addr)
  const b = c.border
  if (!b) return `${addr}: no border`
  const sides = ["top","bottom","left","right"].map(s => b[s] ? `${s}=${b[s].style}/${b[s].color?.argb}` : `${s}=—`).join(" ")
  return `${addr}: ${sides}`
}

console.log("=== TITLE ROWS (must have NO borders) ===")
for (const a of ["A1","C1","L1","A2","C2","L2"]) console.log("  " + describe(a))

console.log("\n=== HEADER ROW 3 cols A-N (must all have THIN_BORDER) ===")
for (let c = 1; c <= 14; c++) {
  console.log("  " + describe(ws.getRow(3).getCell(c).address))
}

console.log("\n=== DATA ROWS 4, 8, 15 cols A,G,N (spot check) ===")
for (const r of [4, 8, 15]) {
  for (const c of [1, 7, 14]) {
    console.log("  " + describe(ws.getRow(r).getCell(c).address))
  }
}

console.log("\n=== BUFFER ROWS 16, 40, 65 cols A,G,N ===")
for (const r of [16, 40, 65]) {
  for (const c of [1, 7, 14]) {
    console.log("  " + describe(ws.getRow(r).getCell(c).address))
  }
}

console.log("\n=== HELPER CELLS (must have NO borders) ===")
for (const a of ["S1", "R1", "S2", "R2", "P2"]) console.log("  " + describe(a))
