import type { TakeoffMatrix } from "./matrix"

// Export the tag×room matrix to .xlsx using the repo's existing Excel lib (exceljs,
// dynamic-imported — same pattern as _shared/excel-export.ts). Layout mirrors the
// user's hand-kept takeoff sheet exactly:
//   title row · header (Tag | Description | TOTAL | <one col per room>) ·
//   per category: a section header row, one row per tag (per-room counts + TOTAL),
//   then a "<CATEGORY> — TOTAL" subtotal row · finally "GRAND TOTAL — PER ROOM".
// Cell rule (matches the on-screen matrix): per-room tag cells are blank at zero;
// TOTAL column + subtotal/grand rows always show a number.

function sanitizeFileName(s: string): string {
  return (s || "takeoff").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "takeoff"
}

export async function exportTakeoffToExcel(args: {
  projectName: string
  takeoffName: string
  matrix: TakeoffMatrix
  /** Pass a stable date string (yyyy-mm-dd) — keeps this fn free of Date.now(). */
  dateStr: string
}): Promise<void> {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  wb.creator = "TuttoHQ"
  const ws = wb.addWorksheet("Takeoff")

  const { matrix } = args
  const rooms = matrix.rooms
  const lastCol = 3 + rooms.length // A=Tag, B=Description, C=TOTAL, then one per room

  const THIN = { style: "thin" as const, color: { argb: "FFD0D7DE" } }
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN }
  const HEADER_BG = "FF1A2840"   // navy (matches app chrome)
  const CAT_BG = "FFEAF0F5"      // light steel
  const SUB_BG = "FFF1F5F9"      // lighter
  const GRAND_BG = "FFDDE6EE"

  // Column widths
  ws.columns = [
    { width: 16 }, { width: 40 }, { width: 10 },
    ...rooms.map(() => ({ width: 12 })),
  ]

  // 1) Title row (merged across all columns)
  ws.mergeCells(1, 1, 1, lastCol)
  const title = ws.getCell(1, 1)
  title.value = `${args.projectName} — ${args.takeoffName}`
  title.font = { name: "Arial", size: 16, bold: true }
  title.alignment = { horizontal: "left", vertical: "middle" }
  ws.getRow(1).height = 24

  // 2) Header row
  const headerLabels = ["Tag", "Description", "TOTAL", ...rooms.map(r => r.name)]
  const headerRow = ws.getRow(2)
  headerRow.height = 22
  headerLabels.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = label
    cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } }
    cell.alignment = { horizontal: i === 1 ? "left" : "center", vertical: "middle", wrapText: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } }
    cell.border = BORDER
  })

  let r = 3
  const blankZero = (n: number) => (n === 0 ? "" : n)

  for (const group of matrix.groups) {
    // Category section header (merged)
    ws.mergeCells(r, 1, r, lastCol)
    const cat = ws.getCell(r, 1)
    cat.value = group.name
    cat.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF1A2840" } }
    cat.alignment = { horizontal: "left", vertical: "middle" }
    cat.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CAT_BG } }
    cat.border = BORDER
    r++

    // Tag rows
    for (const row of group.rows) {
      const xlRow = ws.getRow(r)
      xlRow.getCell(1).value = row.tag.code
      xlRow.getCell(2).value = row.tag.description ?? ""
      xlRow.getCell(3).value = row.total
      rooms.forEach((_, i) => { xlRow.getCell(4 + i).value = blankZero(row.perRoom[i]) })
      for (let c = 1; c <= lastCol; c++) {
        const cell = xlRow.getCell(c)
        cell.font = { name: "Calibri", size: 11 }
        cell.alignment = { horizontal: c === 2 ? "left" : c === 1 ? "left" : "center", vertical: "middle" }
        cell.border = BORDER
      }
      r++
    }

    // Category subtotal row
    const subRow = ws.getRow(r)
    subRow.getCell(1).value = `${group.name} — TOTAL`
    subRow.getCell(3).value = group.subtotalTotal
    rooms.forEach((_, i) => { subRow.getCell(4 + i).value = group.subtotalPerRoom[i] })
    for (let c = 1; c <= lastCol; c++) {
      const cell = subRow.getCell(c)
      cell.font = { name: "Arial", size: 11, bold: true }
      cell.alignment = { horizontal: c <= 2 ? "left" : "center", vertical: "middle" }
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SUB_BG } }
      cell.border = BORDER
    }
    r++
  }

  // Grand total row
  const grandRow = ws.getRow(r)
  grandRow.getCell(1).value = "GRAND TOTAL — PER ROOM"
  grandRow.getCell(3).value = matrix.grandTotal
  rooms.forEach((_, i) => { grandRow.getCell(4 + i).value = matrix.grandPerRoom[i] })
  for (let c = 1; c <= lastCol; c++) {
    const cell = grandRow.getCell(c)
    cell.font = { name: "Arial", size: 11, bold: true }
    cell.alignment = { horizontal: c <= 2 ? "left" : "center", vertical: "middle" }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRAND_BG } }
    cell.border = BORDER
  }

  ws.views = [{ state: "frozen", ySplit: 2, xSplit: 3 }]

  // Download
  const buf = await wb.xlsx.writeBuffer()
  const name = `${sanitizeFileName(args.projectName)}_${sanitizeFileName(args.takeoffName)}_takeoff_${args.dateStr}.xlsx`
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
