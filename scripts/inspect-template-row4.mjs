import ExcelJS from "exceljs"
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile("C:\\Users\\jacei_7431w1\\Downloads\\Submittal_Log.xlsx")
const ws = wb.worksheets[0]
for (let c = 1; c <= 14; c++) {
  const cell = ws.getRow(4).getCell(c)
  console.log(`${cell.address}: value=${JSON.stringify(cell.value)} font=${JSON.stringify(cell.font)} align=${JSON.stringify(cell.alignment)}`)
}
