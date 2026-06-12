// Generates a SYNTHETIC THP-format PCO workbook that reproduces the REAL
// "SRC - THP PCO 042.xlsx" structure + its quirks, so the verify harness
// actually exercises them. Dev stand-in only — NOT a substitute for the real
// file.  node scripts/make-thp-pco-042-fixture.mjs
//
// Quirks reproduced (from cell-level inspection of the real file):
//   • Labor header at row 10, a BLANK merged row (A11:B11) before the first
//     data row (12); labor name cells are merged A:B.
//   • A "Unit" column (D) sits BETWEEN reg Qty (C) and reg Rate (E); OT/DT
//     headers are "1-1/2 Rate" / "2x Rate".
//   • Line totals / subtotals / grand total are FORMULAS with cached results.
//   • Date is =TODAY() (volatile) on BOTH sheets — no static date anywhere.
//   • PCO # and Job # are stored as strings.
//   • 6 labor rows (2 real + 4 zero) and 13 material rows (3 real + 10 zero)
//     → exactly 14 zero-qty rows dropped.

import ExcelJS from "exceljs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const out = join(dirname(fileURLToPath(import.meta.url)), "sample-thp-pco-042.xlsx")
const wb = new ExcelJS.Workbook()
const TODAY = { formula: "TODAY()", result: new Date(Date.UTC(2025, 11, 3)) }   // volatile, cached
const F = (formula, result) => ({ formula, result })

// ── Cover Sheet ─────────────────────────────────────────────────────────────
const cover = wb.addWorksheet("Cover Sheet")
const setC = (addr, v) => { cover.getCell(addr).value = v }
setC("D6", "TOMLINSON HAWLEY PATTERSON")
setC("B9", "DATE:");    setC("C9", TODAY)                    // volatile date
setC("B11", "PROJECT:"); setC("C11", "YNHH St.Raphaels Campus - ED/HVC Renovations Phase 2")
setC("B13", "TITLE:");  setC("C13", "Supply Room Pyrex Panel Installation")
setC("B14", "DESCRIPTION OF WORK:"); setC("C14", "Furnish and install Pyrex panel in the supply room per RFI-018.")
setC("B15", "PCO #");   setC("C15", "42")                    // string PCO #
setC("B16", "SCHEDULE IMPACT (DAYS):"); setC("C16", 0)
setC("B18", "Pricing Summary")
setC("B19", "THP Labor");                setC("C19", 2704.61)
setC("B20", "THP Material & Equipment"); setC("C20", 91.0)
setC("B21", "Subcontractor");            setC("C21", 0)
setC("B22", "Fee");                      setC("C22", 419.34)
setC("B23", "Bond");                     setC("C23", 0)
setC("B24", "TOTAL");                    setC("C24", 3214.95)
setC("B26", "Sincerely,")
setC("B27", "John Smith")
setC("B28", "Project Manager")

// ── Backup Template ─────────────────────────────────────────────────────────
const bk = wb.addWorksheet("Backup Template")
const set = (addr, v) => { bk.getCell(addr).value = v }
const mergeName = (r, name) => { bk.mergeCells(`A${r}:B${r}`); if (name != null) bk.getCell(`A${r}`).value = name }

set("I3", "THP PCO #:"); set("J3", "42")        // string
set("I5", "THP Job #:"); set("J5", "24-001")    // string, label has '#'
set("I6", "Date:");      set("J6", TODAY)        // volatile

// Labor header (row 10) — note Unit column D between qty C and rate E.
bk.mergeCells("A10:B10"); bk.getCell("A10").value = "Labor"
;["C10","D10","E10","F10","G10","H10","I10","J10"].forEach((a, i) =>
  set(a, ["Qty", "Unit", "Reg Rate", "Qty", "1-1/2 Rate", "Qty", "2x Rate", "Total"][i]))
bk.mergeCells("A11:B11")                          // BLANK merged row before data

// Labor data rows 12-17: merged A:B names, formula line totals with cached result.
const labor = [
  ["Carpenter Foreman", 5, 96.49, 125.45, 154.42, 482.45],
  ["Carpenter",        24, 92.59, 119.60, 146.62, 2222.16],
  ["Laborer Foreman",   0, 81.40, 107.05, 132.69, 0],   // zero-qty → dropped
  ["Laborer",           0, 72.71,  94.08, 115.46, 0],   // zero-qty → dropped
  [null,                0,  0,      0,      0,     0],   // zero-qty → dropped
  [null,                0,  0,      0,      0,     0],   // zero-qty → dropped
]
labor.forEach(([name, qty, reg, ot, dt, total], i) => {
  const r = 12 + i
  mergeName(r, name)
  set(`C${r}`, qty); set(`D${r}`, "hrs"); set(`E${r}`, reg)
  set(`F${r}`, 0); set(`G${r}`, ot); set(`H${r}`, 0); set(`I${r}`, dt)
  set(`J${r}`, F(`(C${r}*E${r})+(F${r}*G${r})+(H${r}*I${r})`, total))
})
mergeName(18, "Total Hours"); set("C18", F("SUM(C12:C15)", 29))
bk.mergeCells("D19:I19"); bk.getCell("D19").value = "Labor Subtotal"
set("J19", F("SUM(J12:J15)", 2704.6099999999997))     // float artifact

// Material / Equipment header (row 23).
bk.mergeCells("A23:B23"); bk.getCell("A23").value = "Material/Equipment"
set("C23", "Qty"); set("D23", "Unit"); set("E23", "Unit Price"); set("J23", "Total")
const mats = [
  ["Screws",  1, "LSUM", 16, 16],
  ["Screws",  1, "LSUM", 7, 7],
  ["Anchors", 4, "EA",  17, 68],
]
mats.forEach(([item, qty, unit, price, total], i) => {
  const r = 24 + i
  bk.mergeCells(`A${r}:B${r}`); bk.getCell(`A${r}`).value = item
  set(`C${r}`, qty); set(`D${r}`, unit); set(`E${r}`, price)
  set(`J${r}`, F(`E${r}*C${r}`, total))
})
for (let r = 27; r <= 36; r++) {                       // 10 zero-qty material rows
  set(`C${r}`, 0); set(`E${r}`, 0); set(`J${r}`, F(`E${r}*C${r}`, 0))
}
set("D37", "     Materials Subtotal"); set("J37", F("SUM(J24:J36)", 91))
set("D39", "      OH&P "); set("J39", F("(J37+J19)*C39", 0))
set("D41", "      Grand Total"); set("J41", F("J39+J37+J19", 2795.6099999999997))

// ── Prem-time sheets (STALE — from OTHER jobs/PCOs) ─────────────────────────
const prem1 = wb.addWorksheet("Prem.Time Bckp Sheet")
prem1.getCell("I3").value = "THP PCO #:"; prem1.getCell("J3").value = "50"
prem1.getCell("A4").value = "Ironworker"; prem1.getCell("C4").value = 16
const prem2 = wb.addWorksheet("Prem.Time Cover Sheet")
prem2.getCell("B10").value = "DATE:"; prem2.getCell("C10").value = TODAY
prem2.getCell("B15").value = "PCO #"; prem2.getCell("C15").value = "40"

await wb.xlsx.writeFile(out)
console.log("Wrote", out)
