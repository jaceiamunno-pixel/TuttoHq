// End-to-end verification of the REAL import parser against a synthetic THP
// fixture (and, if you point it at one, the real workbook). Runs the actual
// parseWorkbookFile → extract → reconcile pipeline, then a tamper case and a
// collision-key check.
//
//   npm run verify:pco-import          # uses scripts/sample-thp-pco-042.xlsx
//   npm run verify:pco-import -- path/to/SRC\ -\ THP\ PCO\ 042.xlsx
//
// (npm script wires the Node flags: --experimental-strip-types + the loader.)

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { parseWorkbookFile } from "../src/lib/pco-import/parse.ts"
import { reconcile } from "../src/lib/pco-import/extract.ts"

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] || join(here, "sample-thp-pco-042.xlsx")

let pass = 0, fail = 0
const eq = (label, got, want) => {
  const ok = got === want
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`)
  ok ? pass++ : fail++
}
const near = (label, got, want, tol = 0.05) => {
  const ok = typeof got === "number" && Math.abs(got - want) <= tol
  console.log(`${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : `  (expected ≈${want})`}`)
  ok ? pass++ : fail++
}

const buf = readFileSync(target)
const file = new File([buf], target.split(/[\\/]/).pop())

console.log(`\n── Parsing ${file.name} ──`)
const res = await parseWorkbookFile(file)
if (!res.pco) {
  console.error("HARD FAILURE — no PCO parsed:", res.fileFlags)
  process.exit(1)
}
const p = res.pco

console.log("\n── Verify #2: documented PCO 042 values ──")
eq("PCO #", p.pcoNumber, "042")
eq("Job # (from backup 'THP Job #:')", p.jobNumber, "24-001")
eq("Title", p.title, "Supply Room Pyrex Panel Installation")
eq("Labor lines kept (4 zero-qty dropped)", p.labor.length, 2)
eq("Carpenter Foreman role (merged A:B cell)", p.labor[0]?.role, "Carpenter Foreman")
near("Carpenter Foreman reg rate (Unit col gap handled)", p.labor[0]?.rate_reg, 96.49)
near("Carpenter reg rate", p.labor[1]?.rate_reg, 92.59)
near("Labor subtotal", p.computed.laborSubtotal, 2704.61)
near("Materials subtotal", p.computed.materialsSubtotal, 91.0)
eq("Material lines kept (10 zero-qty dropped)", p.materials.length, 3)
near("Fee (stated)", p.stated.coverFee, 419.34)
near("TOTAL (computed grand, formula cells resolved)", p.computed.total, 3214.95)

console.log("\n── Verify (c): volatile TODAY()/NOW() date is NOT trusted ──")
eq("dateISO not auto-filled from TODAY()", p.dateISO, null)
eq("cached date surfaced as a suggestion", p.dateSuggestion, "2025-12-03")
eq("card flagged volatile_date", !!p.flags.find(f => f.code === "volatile_date"), true)
eq("no other blocking flags (clean apart from the date)", p.flags.filter(f => f.code !== "volatile_date").length, 0)

const premNote = p.notes.find(n => /prem/i.test(n) && /ignored/i.test(n))
eq("prem-time sheet(s) ignored w/ reason", !!premNote, true)
if (premNote) console.log("   ↳", premNote)
const dropMatch = (p.notes.find(n => /zero-quantity/i.test(n)) || "").match(/Dropped (\d+)/)
eq("zero-qty rows dropped = 14 (4 labor + 10 material)", dropMatch ? Number(dropMatch[1]) : -1, 14)

console.log("\n── Verify #3: tamper test (rate changed → stated ≠ computed) ──")
const tampered = structuredClone(p)
tampered.labor[1].rate_reg = 99.59           // was 92.59
const recon = reconcile(tampered.labor, tampered.materials, tampered.stated)
const mathFlag = recon.flags.find(f => f.code === "math_mismatch")
eq("Tamper raises math_mismatch", !!mathFlag, true)
if (mathFlag) console.log(`   ↳ ${mathFlag.message}`)

console.log("\n── Verify #4: collision key ──")
const key = (p.pcoNumber || "").replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "")
eq("Numeric collision key for re-import", key, "42")

console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
