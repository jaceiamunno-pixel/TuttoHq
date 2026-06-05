// READ-ONLY: dump every AcroForm widget for the suspect files, highlight
// which field the current extractor picks for approvalDate, and surface
// every date-shaped value so we can identify the correct architect-
// approval date.
//
// Mirrors the value-shape recovery (latest date wins) + Waters template
// hard-coding (Text4#1 → date) used by src/lib/bulk-import-form.ts.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList } from "pdf-lib"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const companyId = "c7c08273-8d0a-40fd-8f67-b712955eeb47"
const FILES = [
  { sub: "234-R2", path: companyId + "/bulk-import-staging/3816c072-5b86-4d3e-83e5-a911bed3e0ee_0301-0509_Sub_No_234_-R2_Ceramic_Tile_Sample.pdf" },
  { sub: "234-R3", path: companyId + "/bulk-import-staging/be2cd057-92f5-4960-8851-ea9888b2bf38_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
  { sub: "287",    path: companyId + "/bulk-import-staging/a3edb736-23a2-4215-896a-bb7fde894046_0301-0509_Sub_No_287_SWP_Inst_Wind_Screen.pdf" },
  { sub: "361",    path: companyId + "/bulk-import-staging/e3716962-a79f-4322-9830-d2f352d8ab6c_0301-0509_Sub_No_361_SWP_Inst_Coiling_Counter_Drs.pdf" },
  { sub: "364",    path: companyId + "/bulk-import-staging/75914750-cc08-486d-a8be-d4723d2c83f0_0301-0509_Sub_No_364_Ceramic_Tile_Sample_CT3.pdf" },
  { sub: "370",    path: companyId + "/bulk-import-staging/3af77982-fc0e-429e-bece-d3c0ca448a34_0301-0509_Sub_No_370_Flooring_Sample_III.pdf" },
]

async function rawFields(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
  const out = {}
  for (const f of doc.getForm().getFields()) {
    const name = f.getName()
    let value = null
    if (f instanceof PDFTextField) value = f.getText() ?? null
    else if (f instanceof PDFDropdown) { const s = f.getSelected(); value = s?.length ? s.join(", ") : null }
    else if (f instanceof PDFOptionList) { const s = f.getSelected(); value = s?.length ? s.join(", ") : null }
    else if (f instanceof PDFCheckBox) value = f.isChecked() ? "true" : ""
    if (value && value.trim()) out[name] = value.trim()
  }
  return out
}

// What the current production extractor picks as approval date:
// 1) Waters template (detected by dashed XX-XX-XX section anywhere): Text4#1 || Text4
// 2) Other: latest-dated value in the form
const WATERS_DASHED = /(\d{2})-(\d{2})-(\d{2})(?!\d)/
const VALID_DIV = new Set(["00","01","02","03","04","05","06","07","08","09","10","11","12","13","14","21","22","23","25","26","27","28","31","32","33","34","35","40","41","42","43","44","46","48"])
function isWatersTemplate(raw) {
  for (const v of Object.values(raw)) {
    const m = v.match(WATERS_DASHED)
    if (m && VALID_DIV.has(m[1])) return true
  }
  return false
}
const DATE_SHAPES = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/,
  /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,
]
function isDateShape(v) { const s = v.trim(); return DATE_SHAPES.some(re => re.test(s)) }

for (const f of FILES) {
  console.log("\n" + "═".repeat(80))
  console.log("Sub# " + f.sub + " — " + f.path.split("/").pop())
  console.log("═".repeat(80))

  const { data: blob, error } = await a.storage.from("submittals").download(f.path)
  if (error || !blob) { console.log("  download failed:", error?.message); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())

  let raw
  try { raw = await rawFields(buffer) } catch (e) { console.log("  pdf-lib load failed:", e.message); continue }

  console.log("\n  ALL RAW WIDGETS (" + Object.keys(raw).length + "):")
  for (const [k, v] of Object.entries(raw)) {
    console.log("    " + k.padEnd(18) + " = " + JSON.stringify(v).slice(0, 100))
  }

  console.log("\n  ALL DATE-SHAPED VALUES:")
  for (const [k, v] of Object.entries(raw)) {
    if (isDateShape(v)) console.log("    " + k.padEnd(18) + " = " + JSON.stringify(v))
  }

  const template = isWatersTemplate(raw) ? "waters" : "other"
  console.log("\n  TEMPLATE DETECTED: " + template)

  let extractorPicks = null
  let extractorSource = null
  if (template === "waters") {
    extractorPicks = raw["Text4#1"] ?? raw["Text4"] ?? null
    extractorSource = raw["Text4#1"] ? "Text4#1" : (raw["Text4"] ? "Text4" : null)
  } else {
    // value-shape recovery: latest dated value
    let latest = null
    let latestKey = null
    let latestKeyName = null
    function dateSort(v) {
      const s = v.trim()
      let m
      if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
        const [, mo, d, y] = m
        const fy = y.length === 4 ? y : (parseInt(y) <= 50 ? "20" + y : "19" + y)
        return parseInt(fy + mo.padStart(2,"0") + d.padStart(2,"0"))
      }
      if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return parseInt(m[1]+m[2]+m[3])
      return null
    }
    for (const [k, v] of Object.entries(raw)) {
      if (!isDateShape(v)) continue
      const key = dateSort(v)
      if (key !== null && (latestKey === null || key > latestKey)) {
        latest = v; latestKey = key; latestKeyName = k
      }
    }
    extractorPicks = latest
    extractorSource = latestKeyName
  }
  console.log("\n  EXTRACTOR currently picks: " + JSON.stringify(extractorPicks) + "  (from field " + JSON.stringify(extractorSource) + ")")
}
