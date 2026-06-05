// Deep-inspect approach: for each sample PDF, scan ALL pages for any
// occurrence of approval-stamp vocabulary (Approved, Exceptions, Returned,
// Revise and Resubmit, "for the Contract") and surrounding context, plus
// dump ALL AcroForm widgets (not just Text1..Text10 — the architect stamp
// may live in a separately-named field). Read-only.

import { createClient } from "@supabase/supabase-js"
import { extractText, getDocumentProxy } from "unpdf"
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList } from "pdf-lib"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const SAMPLES = [
  { id: "Sub 079 Ceramic Tile",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/7b25eb00-e55e-4c54-b743-824559af8828_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
  { id: "Sub 147 NSMF",               path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/24c39197-c9ec-4f19-85bf-08853fd31807_0301-0509_Sub_No_147_NSMF.pdf" },
  { id: "Sub 118 Wall Insulation",    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/b84ba9a8-a916-47fe-9811-3f9fdb13d410_0301-0509_Sub_No_118_Wall_Insulation.pdf" },
  { id: "Sub 234-R3 Ceramic Tile Sample", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/245852a2-adfd-4a0c-b011-387a1b3d12cb_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
]

// Stamp-vocabulary patterns: text snippets we want to see in context.
const STAMP_RE = /\b(Approved|Exceptions\s+Noted|Returned\s+for|Revise\s+and\s+Resubmit|Not\s+Approved|Submittal\s+Disposition|Reviewed\s+for|Date\s+Returned|Date\s+Approved|Submittal\s+Review\s+Completed|Approved\s+as\s+(?:submitted|noted))\b/gi

// Generic date-shape patterns to look for near stamp vocabulary.
const DATE_PATTERNS = [
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/,
  /\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\b/,
]
const isDate = s => DATE_PATTERNS.some(re => re.test(s))

for (const s of SAMPLES) {
  console.log("\n" + "═".repeat(80))
  console.log(s.id)
  console.log("═".repeat(80))
  const { data: blob, error } = await a.storage.from("submittals").download(s.path)
  if (error) { console.log("  download err:", error.message); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())

  // (1) AcroForm widgets — ALL of them
  console.log("\n── ALL FORM WIDGETS ──")
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
    const fields = doc.getForm().getFields()
    for (const f of fields) {
      const name = f.getName()
      let value = null
      if (f instanceof PDFTextField) value = f.getText() ?? null
      else if (f instanceof PDFDropdown) { const x = f.getSelected(); value = x?.length ? x.join(", ") : null }
      else if (f instanceof PDFOptionList) { const x = f.getSelected(); value = x?.length ? x.join(", ") : null }
      else if (f instanceof PDFCheckBox) value = f.isChecked() ? "true" : ""
      if (value && value.trim()) console.log("  " + name.padEnd(28) + " = " + JSON.stringify(value).slice(0, 100))
    }
  } catch (e) { console.log("  pdf-lib err:", e.message) }

  // (2) Page text — scan ALL pages for stamp vocabulary, show surrounding context
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  console.log("\n── STAMP VOCABULARY HITS (across", pages.length, "pages) ──")
  let totalHits = 0
  for (let p = 0; p < pages.length; p++) {
    const t = pages[p]
    let m
    STAMP_RE.lastIndex = 0
    while ((m = STAMP_RE.exec(t)) !== null) {
      totalHits++
      const start = Math.max(0, (m.index ?? 0) - 60)
      const end   = Math.min(t.length, (m.index ?? 0) + 120)
      const ctx = t.slice(start, end).replace(/\s+/g, " ").trim()
      const nearbyDate = isDate(ctx) ? "  ← contains a date" : ""
      console.log(`  page ${p+1}: …${ctx}…${nearbyDate}`)
    }
  }
  if (totalHits === 0) console.log("  (no stamp-vocabulary hits anywhere in the PDF)")
}
