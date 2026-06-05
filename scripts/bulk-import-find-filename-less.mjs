// READ-ONLY diagnostic: find the actual "0301-0509 Sub No 0XX" batch
// files in production storage, run them through the same form-recovery +
// detection pipeline the deployed analyze route uses, and dump:
//   - Filename (to confirm no section in the filename)
//   - Filename parser result (should be null for these — proves we're
//     testing the form-recovery path, not the filename fallback)
//   - Raw AcroForm widget map (every field name + value)
//   - Recovered cover fields + confidence
//   - Final suggested section + source
//
// Mirrors src/lib/bulk-import-form.ts + bulk-import-detect.ts. If the
// recovery fails on these files, the inline widget dump tells us exactly
// what's there so we can fix the heuristic.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList } from "pdf-lib"
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
    return { __error: e?.message ?? String(e) }
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

const SECTION_SHAPE = /^\s*(\d{2})[\s.\-]?(\d{2})[\s.\-]?(\d{2})(?:[\s.\-]?\d{2})?\s*$/
function isSectionShape(v) {
  const m = v.match(SECTION_SHAPE)
  return !!m && VALID_DIVISIONS.has(m[1])
}

function recoverByValueShape(raw) {
  const entries = Object.entries(raw)
  let specSection = null
  let sectionFieldIdx = -1
  for (let i = 0; i < entries.length; i++) {
    if (!specSection && isSectionShape(entries[i][1])) {
      specSection = entries[i][1]
      sectionFieldIdx = i
    }
  }
  return { specSection, sectionFieldIdx }
}

// Waters template detection + extractor (mirrors src/lib/bulk-import-form.ts).
const WATERS_DASHED_SECTION_RE = /(\d{2})-(\d{2})-(\d{2})(?!\d)/
function detectTemplate(raw) {
  for (const v of Object.values(raw)) {
    const m = v.match(WATERS_DASHED_SECTION_RE)
    if (m && VALID_DIVISIONS.has(m[1])) return "waters"
  }
  for (const v of Object.values(raw)) {
    if (isSectionShape(v)) return "bam-thp"
  }
  return "unknown"
}
function lookupByExactName(raw, ...names) {
  for (const n of names) {
    if (raw[n] && raw[n].trim()) return raw[n].trim()
  }
  return null
}
function extractWatersSections(value) {
  const out = []
  for (const m of value.matchAll(/(\d{2})-(\d{2})-(\d{2})(?!\d)/g)) {
    if (VALID_DIVISIONS.has(m[1])) out.push(`${m[1]} ${m[2]} ${m[3]}`)
  }
  return out
}
function recoverWatersFields(raw) {
  let primarySection = null
  let additional = []
  const text6 = lookupByExactName(raw, "Text6#1", "Text6")
  if (text6) {
    const secs = extractWatersSections(text6)
    if (secs.length > 0) { primarySection = secs[0]; additional = secs.slice(1) }
  }
  if (!primarySection) {
    for (const v of Object.values(raw)) {
      const secs = extractWatersSections(v)
      if (secs.length > 0) { primarySection = secs[0]; additional = secs.slice(1); break }
    }
  }
  return {
    fields: {
      specSectionNo:    primarySection,
      specSectionTitle: lookupByExactName(raw, "Text8#1", "Text8"),
      submittalNo:      lookupByExactName(raw, "Text5#1", "Text5"),
      dateSubmitted:    lookupByExactName(raw, "Text4#1", "Text4"),
      projectName:      null,
      submitter:        lookupByExactName(raw, "Text1#1", "Text1"),
    },
    additionalSections: additional,
  }
}

function recoverCoversheetFields(raw) {
  const template = detectTemplate(raw)
  if (template === "waters") {
    const w = recoverWatersFields(raw)
    return {
      fields: w.fields,
      confidence: {
        specSectionNo:    w.fields.specSectionNo    ? "label" : "none",
        specSectionTitle: w.fields.specSectionTitle ? "label" : "none",
        submittalNo:      w.fields.submittalNo      ? "label" : "none",
        dateSubmitted:    w.fields.dateSubmitted    ? "label" : "none",
        projectName:      "none",
        submitter:        w.fields.submitter        ? "label" : "none",
      },
      template,
      additionalSections: w.additionalSections,
    }
  }
  // BAM/THP path (simplified for diagnostic — full version in production)
  const label = {
    specSectionNo:    lookup(raw, "Spec Section No", "Specification Section No", "Section No", "Spec Section Number", "SpecSectionNo"),
    specSectionTitle: lookup(raw, "Spec Section Title", "Section Title", "Specification Section Title", "SpecSectionTitle"),
    submittalNo:      lookup(raw, "Submittal No", "Submittal Number", "SubmittalNo", "Sub No", "Submittal #"),
    dateSubmitted:    lookup(raw, "Date Submitted", "Submitted Date", "DateSubmitted", "Date", "Submitted On"),
    projectName:      lookup(raw, "Project Name", "ProjectName", "Project"),
  }
  const shape = recoverByValueShape(raw)
  return {
    fields: {
      specSectionNo:    label.specSectionNo ?? shape.specSection,
      specSectionTitle: label.specSectionTitle,
      submittalNo:      label.submittalNo,
      dateSubmitted:    label.dateSubmitted,
      projectName:      label.projectName,
      submitter:        null,
    },
    confidence: { specSectionNo: label.specSectionNo ? "label" : (shape.specSection ? "positional" : "none") },
    template,
    additionalSections: [],
  }
}

async function listAllSubmittalFiles(admin, companyId) {
  // List ALL files under the company's uploads dir, paginated.
  const out = []
  let offset = 0
  const limit = 100
  while (true) {
    const { data, error } = await admin.storage.from("submittals").list(
      `${companyId}/uploads`,
      { limit, offset, sortBy: { column: "created_at", order: "desc" } },
    )
    if (error) { console.error("list error:", error.message); break }
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < limit) break
    offset += limit
    if (out.length > 1000) break // safety
  }
  return out
}

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"); process.exit(1)
  }
  const admin = createClient(url, key, { auth: { persistSession: false } })

  // List every top-level directory at the bucket root — each is a company.
  console.log("\nDiscovering companies at the bucket root...")
  const { data: roots, error: rootErr } = await admin.storage.from("submittals").list("", { limit: 100 })
  if (rootErr) { console.error("Root list failed:", rootErr.message); process.exit(1) }
  const companies = (roots ?? []).filter(r => r.id === null).map(r => r.name)  // dirs have null id
  console.log(`Companies: ${companies.length}`)
  for (const c of companies) console.log("  -", c)

  // For EACH company, look in uploads/ AND bulk-import-staging/. Bulk import
  // staging is where files live mid-flow — that's the most likely place the
  // user's "0301-0509 Sub No" batch is sitting RIGHT NOW.
  const all = []
  for (const companyId of companies) {
    for (const sub of ["uploads", "bulk-import-staging"]) {
      let offset = 0
      const limit = 100
      while (true) {
        const { data, error } = await admin.storage.from("submittals").list(
          `${companyId}/${sub}`,
          { limit, offset, sortBy: { column: "created_at", order: "desc" } },
        )
        if (error) break
        if (!data || data.length === 0) break
        for (const f of data) {
          if (/\.pdf$/i.test(f.name)) all.push({ companyId, sub, name: f.name })
        }
        if (data.length < limit) break
        offset += limit
      }
    }
  }
  console.log(`\nFound ${all.length} PDFs across all companies / uploads + staging.`)

  // Filter for the "filename-less" batch — filename does NOT yield a CSI
  // section. Match the user's described pattern: contains "Sub No" or a
  // "DDDD-DDDD" sheet range that ISN'T a valid CSI section prefix.
  const candidates = all.filter(f => {
    const fromFilename = parseSectionFromFilename(f.name).section
    if (fromFilename) return false
    return /Sub\s*No/i.test(f.name) || /\b\d{4}[-_]\d{4}\b/.test(f.name)
  })

  console.log(`Filtered to ${candidates.length} filename-less candidates.\n`)
  if (candidates.length === 0) {
    console.log("No filename-less candidates found across companies.")
    console.log("\nSample of recent filenames seen (to verify):")
    for (const f of all.slice(0, 20)) console.log(`  - [${f.sub}] ${f.name}`)
    process.exit(0)
  }

  const toTest = candidates.slice(0, 3)
  console.log(`Testing first ${toTest.length}:`)
  for (const f of toTest) console.log(`  - [${f.companyId}/${f.sub}] ${f.name}`)
  console.log()

  let i = 0
  for (const f of toTest) {
    i++
    const fullPath = `${f.companyId}/${f.sub}/${f.name}`
    console.log("\n" + "═".repeat(82))
    console.log(`FILENAME-LESS FILE ${i}/${toTest.length}`)
    console.log("Storage path:", fullPath)
    console.log("Filename:", f.name)
    console.log("═".repeat(82))

    const filenameSection = parseSectionFromFilename(f.name)
    console.log(`\n  Filename parser:  section=${JSON.stringify(filenameSection.section)} source=${filenameSection.source}`)
    if (filenameSection.section) {
      console.log("  ⚠ Filename DID resolve — this isn't truly filename-less; skipping.")
      continue
    }

    const { data: blob, error } = await admin.storage.from("submittals").download(fullPath)
    if (error || !blob) { console.log("  ✗ download failed:", error?.message); continue }
    const buffer = Buffer.from(await blob.arrayBuffer())

    const rawForm = await extractRawFormFields(buffer)
    if (rawForm.__error) {
      console.log("  ✗ pdf-lib load failed:", rawForm.__error)
      continue
    }
    console.log(`\n  RAW form widgets (${Object.keys(rawForm).length}):`)
    for (const [k, v] of Object.entries(rawForm)) {
      console.log(`    ${JSON.stringify(k)}: ${JSON.stringify(v).slice(0, 140)}`)
    }

    const { fields, template, additionalSections } = recoverCoversheetFields(rawForm)
    const formSection = fields.specSectionNo  // already normalized to "XX YY ZZ" by Waters extractor
                       ?? normalizeSpecSection(fields.specSectionNo)

    console.log(`\n  DETECTED TEMPLATE: ${template}`)
    console.log(`\n  RECOVERED:`)
    console.log(`    Spec Section No:          ${JSON.stringify(formSection)}`)
    if (additionalSections.length > 0) {
      console.log(`    Additional sections:      ${JSON.stringify(additionalSections)}`)
    }
    console.log(`    Spec Section Title:       ${JSON.stringify(fields.specSectionTitle)}`)
    console.log(`    Submittal No:             ${JSON.stringify(fields.submittalNo)}`)
    console.log(`    Date Submitted:           ${JSON.stringify(fields.dateSubmitted)}`)
    console.log(`    Submitter:                ${JSON.stringify(fields.submitter)}`)
    console.log(`    Project Name:             ${JSON.stringify(fields.projectName)}`)

    if (!formSection) {
      console.log(`\n  ❌ NO section recovered from form widgets. Filename also empty. Production would show empty section.`)
    } else {
      console.log(`\n  ✅ Section recovered from form: ${formSection}${additionalSections.length > 0 ? `  (+ ${additionalSections.length} more)` : ""}`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
