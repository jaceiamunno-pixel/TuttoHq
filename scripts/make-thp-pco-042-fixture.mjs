// Generates a SYNTHETIC THP-format PCO workbook that mirrors the documented
// "SRC - THP PCO 042.xlsx" structure (Cover Sheet + Backup Template + a stale
// Prem.Time sheet from another job). This is a dev stand-in for driving the
// import flow until the real file is supplied — NOT a substitute for verifying
// against the real workbook.
//
//   node scripts/make-thp-pco-042-fixture.mjs
//
// Encodes: PCO #42, Job 24-001, 12/3/2025, "Supply Room Pyrex Panel
// Installation", labor (Carpenter Foreman 5@96.49 + Carpenter 24@92.59, plus a
// zero-qty Laborer row to be dropped), materials 3 lines = 91.00, Fee 419.34,
// TOTAL 3214.95, OH&P 0, Bond 0. Stated subtotals carry float artifacts.

import ExcelJS from "exceljs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const out = join(dirname(fileURLToPath(import.meta.url)), "sample-thp-pco-042.xlsx")
const wb = new ExcelJS.Workbook()

// ── Cover Sheet ─────────────────────────────────────────────────────────────
const cover = wb.addWorksheet("Cover Sheet")
const setC = (r, a, b) => { cover.getCell(`A${r}`).value = a; if (b !== undefined) cover.getCell(`B${r}`).value = b }
setC(1, "Tomlinson Hawley Patterson")
setC(2, "Project:", "Acme HQ Renovation")
setC(3, "THP PCO #:", 42)
setC(4, "Date:", new Date(Date.UTC(2025, 11, 3)))
setC(5, "Title:", "Supply Room Pyrex Panel Installation")
setC(6, "Description of Work:", "Furnish and install Pyrex panel in the supply room per RFI-018.")
setC(7, "Schedule Impact (days):", 0)
setC(9, "Pricing Summary")
setC(10, "THP Labor", 2704.61)
setC(11, "THP Material & Equipment", 91.0)
setC(12, "Subcontractor", 0)
setC(13, "Fee", 419.34)
setC(14, "Bond", 0)
setC(15, "TOTAL", 3214.95)
setC(17, "Sincerely,")
setC(18, "John Smith")
setC(19, "Project Manager")

// ── Backup Template ─────────────────────────────────────────────────────────
const bk = wb.addWorksheet("Backup Template")
const rowB = (r, cells) => cells.forEach((v, i) => { if (v !== null && v !== undefined && v !== "") bk.getCell(r, i + 1).value = v })
rowB(2, ["THP PCO #:", 42])
rowB(3, ["Job #:", "24-001"])
rowB(4, ["Date:", new Date(Date.UTC(2025, 11, 3))])
rowB(6, ["Labor", "Qty", "Reg Rate", "Qty", "1.5× Rate", "Qty", "2× Rate", "Total"])
rowB(7, ["Carpenter Foreman", 5, 96.49, 0, 0, 0, 0, 482.45])
rowB(8, ["Carpenter", 24, 92.59, 0, 0, 0, 0, 2222.16])
rowB(9, ["Laborer", 0, 45.0, 0, 0, 0, 0, 0])              // zero-qty → dropped
rowB(10, ["Total Hours", 29])
rowB(11, ["Labor Subtotal", "", "", "", "", "", "", 2704.6099999999997]) // float artifact
rowB(13, ["Material / Equipment", "Qty", "Unit", "Unit Price", "Description", "Total"])
rowB(14, ["Pyrex Panel", 1, "ea", 70.0, "", 70.0])
rowB(15, ["Fasteners", 2, "box", 7.5, "stainless", 15.0])
rowB(16, ["Sealant", 1, "tube", 6.0, "", 6.0])
rowB(17, ["Materials Subtotal", "", "", "", "", 91.0])
rowB(19, ["OH&P", 0])
rowB(20, ["Grand Total", 2795.61])

// ── Prem.Time (STALE — belongs to PCO 50 of a DIFFERENT job) ─────────────────
const prem = wb.addWorksheet("Prem.Time")
prem.getCell("A1").value = "THP PCO #:"
prem.getCell("B1").value = 50
prem.getCell("A2").value = "Premium Time — (leftover sheet from another project)"
prem.getCell("A4").value = "Ironworker"
prem.getCell("B4").value = 16
prem.getCell("C4").value = 120.0

await wb.xlsx.writeFile(out)
console.log("Wrote", out)
