// Validate the NEW bulk-import detection (with AcroForm field extraction)
// against REAL THP PDFs from production storage. The synthetic PDF used in
// the earlier smoke test wrote section text as static content-stream text,
// so it never reproduced the actual form-widget condition — that's why
// detection looked fine in the smoke test but failed in the field.
//
// This script downloads three real signed THP submittals, runs the new
// pipeline (text + AcroForm fields → analyzePdf), and prints per-file
// results so we can verify section detection succeeds with the form-field
// path before any commit.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

function loadEnvLocal() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const envPath = resolve(here, "..", ".env.local")
    const text = readFileSync(envPath, "utf-8")
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const [, k, v] = m
      if (process.env[k] == null) process.env[k] = v.replace(/^['"]|['"]$/g, "")
    }
  } catch {}
}

// ── Inline copies of the production detection logic ────────────────────────
// (mirrors src/lib/bulk-import-detect.ts + src/lib/bulk-import-form.ts so
// this script runs as plain ESM without a tsc step. Keep these in sync.)

const VALID_DIVISIONS = new Set([
  "00","01","02","03","04","05","06","07","08","09","10","11","12",
  "13","14","21","22","23","25","26","27","28","31","32","33","34",
  "35","40","41","42","43","44","46","48",
])
const isValid = (six) => /^\d{6}$/.test(six) && VALID_DIVISIONS.has(six.slice(0, 2))
const fmt = (six) => `${six.slice(0,2)} ${six.slice(2,4)} ${six.slice(4,6)}`

function parseSectionFromFilename(filename) {
  const base = filename.replace(/\.[^./\\]+$/, "")
  const newer = base.match(/_SUB_(\d{6})_/i)
  if (newer && isValid(newer[1])) return { section: fmt(newer[1]), source: "newer-sub" }
  for (const m of base.matchAll(/(?<!\d)(\d{8})(?!\d)/g)) {
    const six = m[1].slice(0, 6)
    if (isValid(six)) return { section: fmt(six), source: "older-8digit" }
  }
  for (const m of base.matchAll(/(?<!\d)(\d{6})(?!\d)/g)) {
    if (isValid(m[1])) return { section: fmt(m[1]), source: "loose-6digit" }
  }
  return { section: null, source: "none" }
}

function normalizeSpecSection(raw) {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, "")
  if (digits.length === 8) {
    const six = digits.slice(0, 6)
    if (isValid(six)) return fmt(six)
  }
  if (digits.length === 6 && isValid(digits)) return fmt(digits)
  return null
}

const MONTH_NAMES_NORM = ["january","february","march","april","may","june","july","august","september","october","november","december"]
function monthIdxFromName(s) {
  const p = s.slice(0, 3).toLowerCase()
  return MONTH_NAMES_NORM.findIndex(n => n.startsWith(p))
}
function normalizeApprovalDate(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  let m
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    const [, mo, d, y] = m
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) {
    const [, mo, d, y] = m
    const fullY = parseInt(y, 10) <= 50 ? "20" + y : "19" + y
    return `${fullY}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/))) {
    const [, d, mn, y] = m
    const mi = monthIdxFromName(mn)
    if (mi >= 0) return `${y}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const [, mn, d, y] = m
    const mi = monthIdxFromName(mn)
    if (mi >= 0) return `${y}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  return null
}

async function extractPages(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  return Array.isArray(text) ? text : [text]
}

async function extractRawFormFields(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    })
    const form = doc.getForm()
    const fields = form.getFields()
    const out = {}
    for (const field of fields) {
      const name = field.getName()
      if (!name) continue
      let value = null
      if (field instanceof PDFTextField) value = field.getText() ?? null
      else if (field instanceof PDFDropdown) {
        const sel = field.getSelected(); value = sel?.length ? sel.join(", ") : null
      } else if (field instanceof PDFOptionList) {
        const sel = field.getSelected(); value = sel?.length ? sel.join(", ") : null
      } else if (field instanceof PDFCheckBox) {
        value = field.isChecked() ? "true" : ""
      }
      if (value && value.trim()) out[name] = value.trim()
    }
    return out
  } catch (e) {
    return {}
  }
}

function normalizeKey(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "") }
function lookup(raw, ...candidates) {
  if (Object.keys(raw).length === 0) return null
  const normRaw = Object.entries(raw).map(([k, v]) => [normalizeKey(k), v])
  for (const cand of candidates) {
    const t = normalizeKey(cand)
    for (const [k, v] of normRaw) if (k === t) return v
  }
  for (const cand of candidates) {
    const t = normalizeKey(cand)
    for (const [k, v] of normRaw) if (k.startsWith(t)) return v
  }
  for (const cand of candidates) {
    const t = normalizeKey(cand)
    for (const [k, v] of normRaw) if (k.includes(t)) return v
  }
  return null
}

// Value-shape fallback (mirrors src/lib/bulk-import-form.ts)
const SECTION_SHAPE = /^\s*(\d{2})[\s.\-]?(\d{2})[\s.\-]?(\d{2})(?:[\s.\-]?\d{2})?\s*$/
function isSectionShape(v) {
  const m = v.match(SECTION_SHAPE)
  return !!m && VALID_DIVISIONS.has(m[1])
}
const DATE_SHAPES = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/,
  /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,
]
function isDateShape(v) {
  const s = v.trim()
  return DATE_SHAPES.some(re => re.test(s))
}
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"]
function dateSortKey(v) {
  const s = v.trim()
  let m
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    const [, mo, d, y] = m
    const fullY = y.length === 4 ? y : (parseInt(y) <= 50 ? "20" + y : "19" + y)
    return parseInt(fullY + mo.padStart(2,"0") + d.padStart(2,"0"))
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return parseInt(m[1]+m[2]+m[3])
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/))) {
    const mi = MONTHS.findIndex(n => n.toLowerCase().startsWith(m[2].slice(0,3).toLowerCase()))
    if (mi >= 0) return parseInt(m[3] + String(mi+1).padStart(2,"0") + m[1].padStart(2,"0"))
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mi = MONTHS.findIndex(n => n.toLowerCase().startsWith(m[1].slice(0,3).toLowerCase()))
    if (mi >= 0) return parseInt(m[3] + String(mi+1).padStart(2,"0") + m[2].padStart(2,"0"))
  }
  return null
}
function recoverByValueShape(raw) {
  const entries = Object.entries(raw)
  let specSection = null
  let sectionFieldIdx = -1
  const dates = []
  for (let i = 0; i < entries.length; i++) {
    const v = entries[i][1]
    if (!specSection && isSectionShape(v)) { specSection = v; sectionFieldIdx = i }
    if (isDateShape(v)) {
      const k = dateSortKey(v)
      if (k !== null) dates.push({ value: v, key: k })
    }
  }
  let submittalNo = null
  const start = sectionFieldIdx >= 0 ? sectionFieldIdx + 1 : 0
  for (let i = start; i < entries.length; i++) {
    const v = entries[i][1].trim()
    if (/^\d{1,3}$/.test(v) && (!specSection || v !== specSection.slice(-2))) {
      submittalNo = v; break
    }
  }
  let approvalDate = null
  if (dates.length > 0) { dates.sort((a, b) => b.key - a.key); approvalDate = dates[0].value }
  return { specSection, approvalDate, submittalNo }
}

function recoverStringsByPosition(raw, sectionFieldIdx) {
  const entries = Object.entries(raw)
  let projectName = null
  for (const [, v] of entries) {
    if (/[A-Za-z]/.test(v) && v.length >= 3 && !isSectionShape(v) && !isDateShape(v) && !/^\d+$/.test(v)) {
      projectName = v; break
    }
  }
  let specSectionTitle = null
  if (sectionFieldIdx > 0) {
    for (let i = sectionFieldIdx - 1; i >= 0; i--) {
      const v = entries[i][1].trim()
      if (/[A-Za-z]/.test(v) && v.length >= 3 && !isSectionShape(v) && !isDateShape(v) && !/^\d+$/.test(v)) {
        specSectionTitle = v; break
      }
    }
  }
  return { projectName, specSectionTitle }
}

function recoverCoversheetFields(raw) {
  const label = {
    specSectionNo:    lookup(raw, "Spec Section No", "Specification Section No", "Section No", "Spec Section Number", "SpecSectionNo"),
    specSectionTitle: lookup(raw, "Spec Section Title", "Section Title", "Specification Section Title", "SpecSectionTitle"),
    submittalNo:      lookup(raw, "Submittal No", "Submittal Number", "SubmittalNo", "Sub No", "Submittal #"),
    dateSubmitted:    lookup(raw, "Date Submitted", "Submitted Date", "DateSubmitted", "Date", "Submitted On"),
    projectName:      lookup(raw, "Project Name", "ProjectName", "Project"),
  }
  const shape = recoverByValueShape(raw)
  let sectionFieldIdx = -1
  if (!label.specSectionTitle || !label.projectName) {
    const entries = Object.entries(raw)
    for (let i = 0; i < entries.length; i++) {
      if (isSectionShape(entries[i][1])) { sectionFieldIdx = i; break }
    }
  }
  const strings = recoverStringsByPosition(raw, sectionFieldIdx)
  const fields = {
    specSectionNo:    label.specSectionNo    ?? shape.specSection,
    specSectionTitle: label.specSectionTitle ?? strings.specSectionTitle,
    submittalNo:      label.submittalNo      ?? shape.submittalNo,
    dateSubmitted:    label.dateSubmitted    ?? shape.approvalDate,
    projectName:      label.projectName      ?? strings.projectName,
  }
  const confidence = {
    specSectionNo:    label.specSectionNo    ? "label" : shape.specSection      ? "positional" : "none",
    specSectionTitle: label.specSectionTitle ? "label" : strings.specSectionTitle ? "positional" : "none",
    submittalNo:      label.submittalNo      ? "label" : shape.submittalNo      ? "positional" : "none",
    dateSubmitted:    label.dateSubmitted    ? "label" : shape.approvalDate     ? "positional" : "none",
    projectName:      label.projectName      ? "label" : strings.projectName    ? "positional" : "none",
  }
  return { fields, confidence }
}

const TESTS = [
  {
    label: "FILE 1 — newer SUB_ convention, expected 10 26 00",
    expected: "10 26 00",
    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/26ba2699-b7f5-4ab3-b7a0-ce99621b2d1b_20251229_SUB_102600_5_09A_Corner_Guards___Wall_Protection__Marine_Grade_Caulk__Product_Data_For_Record_BAM_A.pdf",
  },
  {
    label: "FILE 2 — newer SUB_ convention, expected 09 10 00",
    expected: "09 10 00",
    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2c151d98-f5f2-4916-aea9-fcd2459b0871_20260105_SUB_091000_1_Rev.1_09A_Ceilings_Acoustical_Ceiling_Tiles_Product_Data_BAM_A.pdf",
  },
  {
    label: "FILE 3 — older YYYYMMDD_08000006_ convention, expected 08 00 00",
    expected: "08 00 00",
    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/5034ffb1-787c-49b9-aa21-0f05225c935c_20251014_08000006_R1_Acrovyn_Doors_and_Hollow_Metal_Frames_SD___PD_ENR__1_.pdf",
  },
]

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"); process.exit(1)
  }
  const admin = createClient(url, key, { auth: { persistSession: false } })

  let allPass = true
  for (const t of TESTS) {
    const filename = t.path.slice(t.path.lastIndexOf("/") + 1)
    console.log("\n" + "═".repeat(82))
    console.log(t.label)
    console.log("File:", filename)
    console.log("═".repeat(82))

    const { data: blob, error } = await admin.storage.from("submittals").download(t.path)
    if (error || !blob) {
      console.log("  ✗ Could not download:", error?.message)
      allPass = false
      continue
    }
    const buffer = Buffer.from(await blob.arrayBuffer())

    const pages = await extractPages(buffer)
    const rawForm = await extractRawFormFields(buffer)
    const { fields: coverFields, confidence: coverFieldsConfidence } = recoverCoversheetFields(rawForm)

    // Run the same priority logic as production analyzePdf:
    const filenameSection = parseSectionFromFilename(filename)
    const formSection = normalizeSpecSection(coverFields.specSectionNo)
    const suggestedApprovalDate = normalizeApprovalDate(coverFields.dateSubmitted)
    const suggestedSubmittalNo = coverFields.submittalNo?.trim() || null

    let suggestedSection, sectionSource
    if (formSection) { suggestedSection = formSection; sectionSource = "form" }
    else { suggestedSection = filenameSection.section; sectionSource = filenameSection.section ? "filename" : "none" }

    const sectionMatches = suggestedSection === t.expected
    const verdict = sectionMatches ? "✅ PASS" : "❌ FAIL"

    console.log(`\n  RAW form widgets (${Object.keys(rawForm).length} total):`)
    for (const [k, v] of Object.entries(rawForm)) {
      console.log(`    ${JSON.stringify(k)}: ${JSON.stringify(v).slice(0, 100)}`)
    }
    console.log(`\n  RECOVERED form fields  (label/positional/none):`)
    console.log(`    Spec Section No:    ${JSON.stringify(coverFields.specSectionNo)}  [${coverFieldsConfidence.specSectionNo}]  →  normalized: ${JSON.stringify(formSection)}`)
    console.log(`    Spec Section Title: ${JSON.stringify(coverFields.specSectionTitle)}  [${coverFieldsConfidence.specSectionTitle}]`)
    console.log(`    Submittal No:       ${JSON.stringify(coverFields.submittalNo)}  [${coverFieldsConfidence.submittalNo}]`)
    console.log(`    Date Submitted:     ${JSON.stringify(coverFields.dateSubmitted)}  [${coverFieldsConfidence.dateSubmitted}]  →  parsed: ${JSON.stringify(suggestedApprovalDate)}`)
    console.log(`    Project Name:       ${JSON.stringify(coverFields.projectName)}  [${coverFieldsConfidence.projectName}]`)

    console.log(`\n  FILENAME parser (matchAll fix):`)
    console.log(`    section = ${JSON.stringify(filenameSection.section)}  source = ${filenameSection.source}`)

    console.log(`\n  ${verdict}  suggestedSection = ${JSON.stringify(suggestedSection)} (source: ${sectionSource}, expected: ${JSON.stringify(t.expected)})`)

    if (!sectionMatches) allPass = false
  }

  console.log("\n" + "═".repeat(82))
  console.log(allPass ? "✅ ALL FILES PASSED" : "❌ AT LEAST ONE FAILURE")
  process.exit(allPass ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
