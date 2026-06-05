// Smoke test for src/lib/bulk-import-detect.ts pure helpers.
// Synthetic inputs only — real THP PDFs would need a full PDF pipeline.

import {
  parseSectionFromFilename,
  parseSectionFromPageText,
  detectSubmittalType,
  detectCoverSplit,
  analyzePdf,
} from "../src/lib/bulk-import-detect.ts"

function pass(label) { console.log(`  PASS  ${label}`) }
function fail(label, got, want) { console.log(`  FAIL  ${label}\n        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`) }
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) pass(label); else fail(label, got, want)
}

console.log("=== Filename section parsing ===")
check("newer-sub THP filename", parseSectionFromFilename("THP_SUB_102600_5_Rough_Carpentry.pdf"),
  { section: "10 26 00", source: "newer-sub" })
check("older 8-digit THP filename", parseSectionFromFilename("YNHH_08000006_R1_Door_Hardware.pdf"),
  { section: "08 00 00", source: "older-8digit" })
check("loose 6-digit fallback", parseSectionFromFilename("Sample-061000-Rough-Carpentry.pdf"),
  { section: "06 10 00", source: "loose-6digit" })
check("bogus div is rejected", parseSectionFromFilename("project-99-99-99.pdf"),
  { section: null, source: "none" })
check("BAM project number isn't a section", parseSectionFromFilename("BAM-08-100-070.pdf"),
  { section: null, source: "none" })

console.log("\n=== Page-2 section confirm ===")
check("labeled section No. + 6-digit", parseSectionFromPageText("Spec Section No. 102600\nSubmittal No. 5"),
  "10 26 00")
check("labeled section with spaces", parseSectionFromPageText("Spec Section No.: 08 71 00"),
  "08 71 00")
check("labeled section 8-digit (drops sub number)",
  parseSectionFromPageText("Specification Section #: 08000006"),
  "08 00 00")
check("no label -> null", parseSectionFromPageText("Random 102600 floating around"), null)

console.log("\n=== Submittal type ===")
check("Product Data via long form",
  detectSubmittalType("Rough_Carpentry_Product_Data.pdf", ""),
  { type: "Product Data", confident: true, source: "filename" })
check("_SD_ abbrev wins after no long form",
  detectSubmittalType("ABC_SD_001.pdf", ""),
  { type: "Shop Drawing", confident: true, source: "filename" })
check("O&M long form",
  detectSubmittalType("File.pdf", "Operation and Maintenance Manual"),
  { type: "O&M Manual", confident: true, source: "page-text" })
check("Finish Samples -> Sample",
  detectSubmittalType("Finish_Samples.pdf", ""),
  { type: "Sample", confident: true, source: "filename" })
check("ambiguous flagged not confident",
  detectSubmittalType("Submittal_001.pdf", "Submittal Coversheet"),
  { type: null, confident: false, source: "none" })

console.log("\n=== Coversheet split ===")
const archReview = `BAM Submittal Review\nProject Number: 08-100-070\nApproved (A)\nExceptions Noted (EN)\nNot Approved (NA)\nReviewed by`
const submitter = `Submittal Coversheet\nProject Name: YNHH SP-3\nProject Number: 100\nSpec Section No. 10 26 00\nSubmittal No. 5\nDate Submitted: 2026-01-15\nSubmitted By: THP`
const product   = `Rough Carpentry — Product Data\nManufacturer: Generic\nMaterial spec\nDimensions: 2x4`

const r1 = detectCoverSplit([archReview, submitter, product, product, product])
console.log(`  coverSplit=${r1.coverSplit} uncertain=${r1.uncertain} perPage=${JSON.stringify(r1.perPage)}`)
console.log(`    -> ${r1.reason}`)

const r2 = detectCoverSplit(["", submitter, product])
console.log(`  scanned page-1 path: coverSplit=${r2.coverSplit} uncertain=${r2.uncertain} perPage=${JSON.stringify(r2.perPage)}`)
console.log(`    -> ${r2.reason}`)

const r3 = detectCoverSplit([product, product, product])
console.log(`  no coversheet found: coverSplit=${r3.coverSplit} uncertain=${r3.uncertain}`)
console.log(`    -> ${r3.reason}`)

console.log("\n=== End-to-end analyzePdf ===")
const e1 = analyzePdf("THP_SUB_102600_5_PD_Carpentry.pdf", [archReview, submitter, product])
console.log(`  ${JSON.stringify({
  suggestedSection: e1.suggestedSection,
  suggestedType: e1.suggestedType,
  coverSplit: e1.cover.coverSplit,
  needsAttention: e1.needsAttention,
  notes: e1.notes,
}, null, 2)}`)

const e2 = analyzePdf("THP_SUB_999999_5_Unknown.pdf", ["", submitter, product])
console.log(`  scanned-cover + bogus filename:\n${JSON.stringify({
  suggestedSection: e2.suggestedSection,
  filenameSection: e2.filenameSection,
  pageSection: e2.pageSection,
  suggestedType: e2.suggestedType,
  coverSplit: e2.cover.coverSplit,
  needsAttention: e2.needsAttention,
  notes: e2.notes,
}, null, 2)}`)
