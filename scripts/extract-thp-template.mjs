// Extracts the structure of the user's THP-formatted Submittal_Log.xlsx
// so we can rebuild the export to match it. Reports:
//   - title row (text, merge, font, alignment)
//   - column widths and header row
//   - per-row fill colors in column A and the section code in column B
//   - formulas in the Approval Time and Late/On-Time columns
//   - helper-cell contents in columns P/Q/R/S
//   - frozen panes + autofilter
//   - total row count

import ExcelJS from "exceljs"
import { fileURLToPath } from "url"
import path from "path"

const TEMPLATE = "C:\\Users\\jacei_7431w1\\Downloads\\Submittal_Log.xlsx"

function argb(cell) {
  const fg = cell.fill?.fgColor
  if (!fg) return null
  if (fg.argb) return fg.argb
  if (typeof fg.theme === "number") return `theme:${fg.theme}${fg.tint != null ? `,tint:${fg.tint.toFixed(3)}` : ""}`
  if (fg.indexed != null) return `indexed:${fg.indexed}`
  return JSON.stringify(fg)
}

function fontDesc(cell) {
  const f = cell.font
  if (!f) return null
  return {
    name: f.name,
    size: f.size,
    bold: !!f.bold,
    italic: !!f.italic,
    color: f.color?.argb ?? (f.color?.theme != null ? `theme:${f.color.theme}` : null),
  }
}

function alignDesc(cell) {
  const a = cell.alignment
  if (!a) return null
  return { h: a.horizontal, v: a.vertical, wrap: !!a.wrapText }
}

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(TEMPLATE)

console.log("=== WORKSHEETS ===")
wb.eachSheet((ws, id) => {
  console.log(`  [${id}] "${ws.name}" — rows=${ws.rowCount}, cols=${ws.columnCount}, actualRows=${ws.actualRowCount}, actualCols=${ws.actualColumnCount}`)
})

const ws = wb.worksheets[0]
console.log(`\n=== SHEET: "${ws.name}" ===`)
console.log(`rowCount=${ws.rowCount} actualRowCount=${ws.actualRowCount}`)
console.log(`columnCount=${ws.columnCount} actualColumnCount=${ws.actualColumnCount}`)

console.log("\n=== VIEWS / FROZEN PANES ===")
console.log(JSON.stringify(ws.views, null, 2))

console.log("\n=== AUTOFILTER ===")
console.log(JSON.stringify(ws.autoFilter, null, 2))

console.log("\n=== MERGED CELLS ===")
// ExcelJS stores merges on the model. Pull them directly.
const merges = ws.model?.merges ?? []
merges.forEach(m => console.log(`  ${m}`))

console.log("\n=== COLUMN WIDTHS (cols 1-20) ===")
for (let c = 1; c <= 20; c++) {
  const col = ws.getColumn(c)
  console.log(`  col ${c} (${col.letter}): width=${col.width ?? "(default)"}, hidden=${!!col.hidden}`)
}

console.log("\n=== ROW HEIGHTS (rows 1-30) ===")
for (let r = 1; r <= Math.min(30, ws.rowCount); r++) {
  console.log(`  row ${r}: height=${ws.getRow(r).height ?? "(default)"}`)
}

console.log("\n=== TITLE ROW (row 1 + 2, all cells A:N) ===")
for (let r = 1; r <= 3; r++) {
  for (let c = 1; c <= 16; c++) {
    const cell = ws.getRow(r).getCell(c)
    if (cell.value == null && !cell.font && !cell.fill?.fgColor) continue
    console.log(`  R${r}C${c} (${cell.address}):`)
    console.log(`    value=${JSON.stringify(cell.value)}`)
    console.log(`    formula=${cell.formula ?? "—"}`)
    console.log(`    font=${JSON.stringify(fontDesc(cell))}`)
    console.log(`    fill=${argb(cell)}`)
    console.log(`    align=${JSON.stringify(alignDesc(cell))}`)
  }
}

console.log("\n=== HEADER ROW CANDIDATES (rows 1-5, all 16 cols, text contents only) ===")
for (let r = 1; r <= 5; r++) {
  const cells = []
  for (let c = 1; c <= 16; c++) {
    const v = ws.getRow(r).getCell(c).value
    if (v != null) cells.push(`${ws.getRow(r).getCell(c).address}="${typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 40)}"`)
  }
  if (cells.length) console.log(`  row ${r}: ${cells.join(" | ")}`)
}

console.log("\n=== DATA ROWS (rows 4-30 quick scan) ===")
for (let r = 4; r <= Math.min(30, ws.rowCount); r++) {
  const row = ws.getRow(r)
  const colA = row.getCell(1)
  const colB = row.getCell(2)
  const colC = row.getCell(3)
  const colJ = row.getCell(10)
  const colK = row.getCell(11)
  const colL = row.getCell(12)
  console.log(`  row ${r}:`)
  console.log(`    A: value=${JSON.stringify(colA.value)} fill=${argb(colA)}`)
  console.log(`    B: value=${JSON.stringify(colB.value)} fill=${argb(colB)} font=${JSON.stringify(fontDesc(colB))}`)
  console.log(`    C: value=${JSON.stringify(colC.value).slice(0,80)}`)
  console.log(`    J (col 10): value=${JSON.stringify(colJ.value)} formula=${colJ.formula ?? "—"}`)
  console.log(`    K (col 11): value=${JSON.stringify(colK.value)}`)
  console.log(`    L (col 12): value=${JSON.stringify(colL.value)} formula=${colL.formula ?? "—"} fill=${argb(colL)}`)
}

console.log("\n=== UNIQUE SECTION → FILL MAP (col B value → col A/B fill ARGB) ===")
const sectionFills = new Map()
for (let r = 4; r <= ws.rowCount; r++) {
  const sec = ws.getRow(r).getCell(2).value
  if (sec == null) continue
  const fillA = argb(ws.getRow(r).getCell(1))
  const fillB = argb(ws.getRow(r).getCell(2))
  const key = String(sec)
  if (!sectionFills.has(key)) sectionFills.set(key, { rows: [], fillA, fillB })
  sectionFills.get(key).rows.push(r)
}
for (const [sec, info] of sectionFills) {
  console.log(`  "${sec}" → A=${info.fillA}, B=${info.fillB} (rows ${info.rows.slice(0,5).join(",")}${info.rows.length>5?"...":""})`)
}

console.log("\n=== HELPER CELLS (cols P/Q/R/S = 16/17/18/19, rows 1-30) ===")
for (let r = 1; r <= 30; r++) {
  for (let c = 16; c <= 19; c++) {
    const cell = ws.getRow(r).getCell(c)
    if (cell.value == null && !cell.formula) continue
    console.log(`  ${cell.address}: value=${JSON.stringify(cell.value)} formula=${cell.formula ?? "—"} fill=${argb(cell)} font=${JSON.stringify(fontDesc(cell))}`)
  }
}

console.log("\n=== ALL DEFINED FORMULAS IN SHEET ===")
const formulas = new Map()
for (let r = 1; r <= ws.rowCount; r++) {
  for (let c = 1; c <= ws.columnCount; c++) {
    const cell = ws.getRow(r).getCell(c)
    if (cell.formula) {
      const f = cell.formula
      if (!formulas.has(f)) formulas.set(f, [])
      formulas.get(f).push(cell.address)
    }
  }
}
for (const [f, addrs] of formulas) {
  console.log(`  =${f}  →  ${addrs.length} cells: ${addrs.slice(0,8).join(",")}${addrs.length>8?"...":""}`)
}

console.log("\n=== HEADER ROW FONT/FILL CHECK (assuming row 3) ===")
for (let c = 1; c <= 16; c++) {
  const cell = ws.getRow(3).getCell(c)
  console.log(`  ${cell.address}: value=${JSON.stringify(cell.value)} font=${JSON.stringify(fontDesc(cell))} fill=${argb(cell)} align=${JSON.stringify(alignDesc(cell))}`)
}
