// Validate the new TEMPLATE-AGNOSTIC CSI section extractor end-to-end:
//   * BAM/THP files (the previously-tested SUB_ batch) — sanity check that
//     the existing path still works through the generic extractor
//   * Waters files (0301-0509 Sub No batch in staging) — confirm generic
//     extractor handles the "Division NN; Section NN-NN-NN" embedded shape
//   * Synthetic unknown-template form — handcrafted in-script to prove
//     section recovery doesn't depend on template detection
//
// Mirrors src/lib/bulk-import-detect.ts + bulk-import-form.ts. Keep in sync.

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

const VALID_DIVISIONS = new Set([
  "00","01","02","03","04","05","06","07","08","09","10","11","12",
  "13","14","21","22","23","25","26","27","28","31","32","33","34",
  "35","40","41","42","43","44","46","48",
])
function isValidDivision(d) { return VALID_DIVISIONS.has(d) }

// ─── Generic CSI section extractor (mirrors detect.ts) ──────────────────────
const LABELED_SECTION_RE =
  /\b(?:Spec(?:ification)?\s+Section|CSI\s+Section|Section|Spec\s+Sec\.?)\s*(?:No\.?|#|Number)?\s*[:\-]?\s*(\d{2})[-\s.](\d{2})[-\s.](\d{2})(?!\d)/gi
const BARE_SECTION_RE =
  /(?<![\w\d])(\d{2})[-\s.](\d{2})[-\s.](\d{2})(?!\d)/g
const COMPACT_SECTION_RE = /(?<!\d)(\d{6})(?!\d)/g

function findLabeledSectionsInValue(text) {
  if (!text) return []
  const out = []
  for (const m of text.matchAll(LABELED_SECTION_RE)) {
    if (!isValidDivision(m[1])) continue
    const primary = `${m[1]} ${m[2]} ${m[3]}`
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200)
    const siblings = []
    for (const sm of tail.matchAll(BARE_SECTION_RE)) {
      if (isValidDivision(sm[1])) {
        const sib = `${sm[1]} ${sm[2]} ${sm[3]}`
        if (sib !== primary && !siblings.includes(sib)) siblings.push(sib)
      }
      if (siblings.length >= 4) break
    }
    out.push({ primary, siblings })
  }
  return out
}
function findBareSectionsInValue(text) {
  if (!text) return []
  const out = []
  for (const m of text.matchAll(BARE_SECTION_RE)) {
    if (isValidDivision(m[1])) {
      const c = `${m[1]} ${m[2]} ${m[3]}`
      if (!out.includes(c)) out.push(c)
    }
  }
  return out
}
function findCompactSectionsInValue(text) {
  if (!text) return []
  const out = []
  for (const m of text.matchAll(COMPACT_SECTION_RE)) {
    const six = m[1]
    if (isValidDivision(six.slice(0, 2))) {
      const c = `${six.slice(0,2)} ${six.slice(2,4)} ${six.slice(4,6)}`
      if (!out.includes(c)) out.push(c)
    }
  }
  return out
}
function extractCsiSection(rawForm, coverPageTexts) {
  const labeledForm = []
  for (const v of Object.values(rawForm)) for (const h of findLabeledSectionsInValue(v)) labeledForm.push(h)
  const labeledPage = []
  for (const pg of coverPageTexts) for (const h of findLabeledSectionsInValue(pg)) labeledPage.push(h)

  if (labeledForm.length > 0 || labeledPage.length > 0) {
    const all = [...labeledForm, ...labeledPage]
    const distinct = [...new Set(all.map(x => x.primary))]
    if (distinct.length === 1) {
      return {
        primary: distinct[0], siblings: all[0].siblings,
        tier: labeledForm.length > 0 ? "labeled-form" : "labeled-page",
        labeledDisagreement: [],
      }
    }
    return {
      primary: null, siblings: [],
      tier: labeledForm.length > 0 ? "labeled-form" : "labeled-page",
      labeledDisagreement: distinct,
    }
  }
  const bareForm = []
  for (const v of Object.values(rawForm)) bareForm.push(...findBareSectionsInValue(v))
  if (bareForm.length > 0) return { primary: bareForm[0], siblings: [], tier: "bare-form", labeledDisagreement: [] }
  const barePage = []
  for (const pg of coverPageTexts) barePage.push(...findBareSectionsInValue(pg))
  if (barePage.length > 0) return { primary: barePage[0], siblings: [], tier: "bare-page", labeledDisagreement: [] }
  const compactForm = []
  for (const v of Object.values(rawForm)) compactForm.push(...findCompactSectionsInValue(v))
  if (compactForm.length > 0) return { primary: compactForm[0], siblings: [], tier: "compact-form", labeledDisagreement: [] }
  const compactPage = []
  for (const pg of coverPageTexts) compactPage.push(...findCompactSectionsInValue(pg))
  if (compactPage.length > 0) return { primary: compactPage[0], siblings: [], tier: "compact-page", labeledDisagreement: [] }
  return { primary: null, siblings: [], tier: null, labeledDisagreement: [] }
}

async function extractPages(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  return Array.isArray(text) ? text : [text]
}
async function extractRawFormFields(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
    const form = doc.getForm()
    const fields = form.getFields()
    const out = {}
    for (const field of fields) {
      const name = field.getName()
      if (!name) continue
      let value = null
      if (field instanceof PDFTextField) value = field.getText() ?? null
      else if (field instanceof PDFDropdown) { const s = field.getSelected(); value = s?.length ? s.join(", ") : null }
      else if (field instanceof PDFOptionList) { const s = field.getSelected(); value = s?.length ? s.join(", ") : null }
      else if (field instanceof PDFCheckBox) value = field.isChecked() ? "true" : ""
      if (value && value.trim()) out[name] = value.trim()
    }
    return out
  } catch { return {} }
}

// ─── Test cases ────────────────────────────────────────────────────────────
const STORAGE_TESTS = [
  // BAM (was passing before refactor; must still pass via generic extractor)
  { kind: "BAM", expected: "10 26 00",
    storagePath: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/26ba2699-b7f5-4ab3-b7a0-ce99621b2d1b_20251229_SUB_102600_5_09A_Corner_Guards___Wall_Protection__Marine_Grade_Caulk__Product_Data_For_Record_BAM_A.pdf" },
  { kind: "BAM", expected: "09 10 00",
    storagePath: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2c151d98-f5f2-4916-aea9-fcd2459b0871_20260105_SUB_091000_1_Rev.1_09A_Ceilings_Acoustical_Ceiling_Tiles_Product_Data_BAM_A.pdf" },
  { kind: "BAM", expected: "08 00 00",
    storagePath: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/5034ffb1-787c-49b9-aa21-0f05225c935c_20251014_08000006_R1_Acrovyn_Doors_and_Hollow_Metal_Frames_SD___PD_ENR__1_.pdf" },
  // Waters (the filename-less batch from staging)
  { kind: "Waters", expected: "09 68 13",
    storagePath: "c7c08273-8d0a-40fd-8f67-b712955eeb47/bulk-import-staging/8e8503ec-1676-4169-8996-ef4429121d3a_0301-0509_Sub_No_080_Tile_Carpeting.pdf" },
  { kind: "Waters", expected: "09 31 00",
    storagePath: "c7c08273-8d0a-40fd-8f67-b712955eeb47/bulk-import-staging/1d9f92a6-9248-4354-9389-5f54f4b95941_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
]

// Synthetic in-memory PDF tests for the cases we can't pull from storage.
function syntheticCase(name, rawForm, coverPageTexts, expected, extraExpect = {}) {
  return { synthetic: true, name, rawForm, coverPageTexts, expected, extraExpect }
}
const SYNTHETIC_TESTS = [
  syntheticCase("Unknown template — labeled form value",
    { "weird_field_name": "Section 13 34 19" },
    [],
    "13 34 19",
  ),
  syntheticCase("Unknown template — bare form value",
    { "anything": "21 13 13" },
    [],
    "21 13 13",
  ),
  syntheticCase("Unknown template — labeled page text only",
    {},
    ["Project Name: Foo\nSpec Section No. 07 95 53\nSubmitted by..."],
    "07 95 53",
  ),
  syntheticCase("Waters multi-section (Sub 158 shape)",
    { "Text6": "Division 09; Section 09-67-23 & 09-65-19" },
    [],
    "09 67 23",
    { siblings: ["09 65 19"] },
  ),
  syntheticCase("Labeled disagreement — two labeled hits in form",
    { "a": "Section 09-22-16", "b": "Section 10-26-00" },
    [],
    null,
    { disagreement: ["09 22 16", "10 26 00"] },
  ),
  syntheticCase("False positive guard — phone number, no CSI",
    { "phone": "203-334-6888" },
    [],
    null,
  ),
  syntheticCase("Negative guard — ISO date alone",
    { "date": "2025-12-02" },
    [],
    null,
  ),
]

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"); process.exit(1) }
  const admin = createClient(url, key, { auth: { persistSession: false } })

  let allPass = true

  console.log("\n════════════════ STORAGE TESTS (real PDFs) ════════════════\n")
  for (const t of STORAGE_TESTS) {
    const filename = t.storagePath.slice(t.storagePath.lastIndexOf("/") + 1)
    console.log("──", t.kind, "—", filename)
    const { data: blob, error } = await admin.storage.from("submittals").download(t.storagePath)
    if (error || !blob) { console.log("   ✗ download failed:", error?.message); allPass = false; continue }
    const buffer = Buffer.from(await blob.arrayBuffer())
    const pages = await extractPages(buffer)
    const rawForm = await extractRawFormFields(buffer)
    // Use the first 2 pages as cover-page text (matches detect.ts max(coverSplit, 2))
    const coverPages = pages.slice(0, 2)
    const csi = extractCsiSection(rawForm, coverPages)
    const ok = csi.primary === t.expected
    console.log(`   primary=${JSON.stringify(csi.primary)}  tier=${csi.tier}  expected=${JSON.stringify(t.expected)}  ${ok ? "✅" : "❌"}`)
    if (csi.siblings.length > 0) console.log(`   siblings=${JSON.stringify(csi.siblings)}`)
    if (csi.labeledDisagreement.length > 0) console.log(`   labeledDisagreement=${JSON.stringify(csi.labeledDisagreement)}`)
    if (!ok) allPass = false
  }

  console.log("\n════════════════ SYNTHETIC TESTS (in-memory) ════════════════\n")
  for (const t of SYNTHETIC_TESTS) {
    const csi = extractCsiSection(t.rawForm, t.coverPageTexts)
    const primaryOk = csi.primary === t.expected
    let extraOk = true
    if (t.extraExpect.siblings) {
      extraOk = extraOk && JSON.stringify(csi.siblings) === JSON.stringify(t.extraExpect.siblings)
    }
    if (t.extraExpect.disagreement) {
      extraOk = extraOk && JSON.stringify(csi.labeledDisagreement.sort()) === JSON.stringify(t.extraExpect.disagreement.sort())
    }
    const ok = primaryOk && extraOk
    console.log(`── ${t.name}`)
    console.log(`   primary=${JSON.stringify(csi.primary)}  tier=${csi.tier}  expected=${JSON.stringify(t.expected)}`)
    if (csi.siblings.length > 0 || t.extraExpect.siblings) console.log(`   siblings=${JSON.stringify(csi.siblings)}  expected siblings=${JSON.stringify(t.extraExpect.siblings ?? [])}`)
    if (csi.labeledDisagreement.length > 0 || t.extraExpect.disagreement) console.log(`   labeledDisagreement=${JSON.stringify(csi.labeledDisagreement)}  expected=${JSON.stringify(t.extraExpect.disagreement ?? [])}`)
    console.log(`   ${ok ? "✅ PASS" : "❌ FAIL"}`)
    if (!ok) allPass = false
  }

  console.log("\n" + "═".repeat(64))
  console.log(allPass ? "✅ ALL TESTS PASSED" : "❌ AT LEAST ONE FAILED")
  process.exit(allPass ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
