// READ-ONLY diagnostic: pull a handful of real THP signed-submittal PDFs from
// production storage (the same uploads/ files the classify retry test left
// behind) and dump per-page text so we can see WHERE the section/division
// actually live in the page-text layer. Also runs the live detectors over
// each so we can compare what the analyzer reads vs. what's actually on
// each page.
//
// Usage: node scripts/bulk-import-diagnose.mjs
//
// Env vars (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "@supabase/supabase-js"
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

// Inline copies of the detection logic so this script doesn't depend on TS
// compilation. Kept in sync with src/lib/bulk-import-detect.ts.
const VALID_DIVISIONS = new Set([
  "00","01","02","03","04","05","06","07","08","09","10","11","12",
  "13","14","21","22","23","25","26","27","28","31","32","33","34",
  "35","40","41","42","43","44","46","48",
])
function isValidSpecCandidate(six) {
  if (six.length !== 6 || !/^\d{6}$/.test(six)) return false
  return VALID_DIVISIONS.has(six.slice(0, 2))
}
function formatSection(six) {
  return `${six.slice(0,2)} ${six.slice(2,4)} ${six.slice(4,6)}`
}
function parseSectionFromFilename(filename) {
  const base = filename.replace(/\.[^./\\]+$/, "")
  const newer = base.match(/_SUB_(\d{6})_/i)
  if (newer && isValidSpecCandidate(newer[1])) return { section: formatSection(newer[1]), source: "newer-sub" }
  const older = base.match(/(?<!\d)(\d{8})(?!\d)/)
  if (older) {
    const six = older[1].slice(0, 6)
    if (isValidSpecCandidate(six)) return { section: formatSection(six), source: "older-8digit" }
  }
  const loose = base.match(/(?<!\d)(\d{6})(?!\d)/)
  if (loose && isValidSpecCandidate(loose[1])) return { section: formatSection(loose[1]), source: "loose-6digit" }
  return { section: null, source: "none" }
}
function parseSectionFromPageText(pageText) {
  if (!pageText) return null
  const labeled = pageText.match(
    /(?:Spec(?:ification)?\s+Section)\s*(?:No\.?|#|Number)?\s*[:\-]?\s*(\d{2}\s?\d{2}\s?\d{2}|\d{8}|\d{6})/i,
  )
  if (labeled) {
    const raw = labeled[1].replace(/\s+/g, "")
    if (raw.length === 8) {
      const six = raw.slice(0, 6)
      if (isValidSpecCandidate(six)) return formatSection(six)
    } else if (raw.length === 6 && isValidSpecCandidate(raw)) {
      return formatSection(raw)
    }
  }
  return null
}
function looksLikeArchitectReview(text) {
  if (!text) return false
  let hits = 0
  if (/\b(?:Approved|Exceptions\s+Noted|Not\s+Approved|Revise\s+and\s+Resubmit|Reviewed)\b/i.test(text)) hits++
  if (/\b(?:Architect(?:ure)?|BAM|Branding|Interior\s+Design|Strategic\s+Action)\b/i.test(text)) hits++
  if (/\b(?:Project\s*(?:No\.?|Number)|Submittal\s+Review)\b/i.test(text)) hits++
  return hits >= 2
}
function looksLikeSubmitterCoversheet(text) {
  if (!text) return false
  let hits = 0
  if (/Spec(?:ification)?\s+Section\s*(?:No\.?|Title|#|Number)/i.test(text)) hits++
  if (/Submittal\s+(?:No\.?|Number|#)/i.test(text)) hits++
  if (/Date\s+Submitted/i.test(text)) hits++
  if (/Project\s+(?:Name|Number|No\.?)/i.test(text)) hits++
  if (/Submitted\s+(?:By|To)/i.test(text)) hits++
  return hits >= 3
}

async function extractPdfPages(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  return Array.isArray(text) ? text : [text]
}

function searchFor(label, regex, page) {
  const m = page.match(regex)
  if (!m) return `${label}: not in page`
  const idx = m.index
  const ctx = page.slice(Math.max(0, idx - 40), Math.min(page.length, idx + (m[0]?.length ?? 0) + 40))
  return `${label}: found at offset ${idx} — context "${ctx.replace(/\s+/g, " ")}"`
}

const TEST_PATHS = [
  // Newer convention with SUB_XXXXXX — the section is in the filename AND
  // (per the design page) on the submitter coversheet.
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/26ba2699-b7f5-4ab3-b7a0-ce99621b2d1b_20251229_SUB_102600_5_09A_Corner_Guards___Wall_Protection__Marine_Grade_Caulk__Product_Data_For_Record_BAM_A.pdf",
  // Newer convention, with the 09A spec section text.
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2c151d98-f5f2-4916-aea9-fcd2459b0871_20260105_SUB_091000_1_Rev.1_09A_Ceilings_Acoustical_Ceiling_Tiles_Product_Data_BAM_A.pdf",
  // Older convention (08000006) — pure 8-digit filename.
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/5034ffb1-787c-49b9-aa21-0f05225c935c_20251014_08000006_R1_Acrovyn_Doors_and_Hollow_Metal_Frames_SD___PD_ENR__1_.pdf",
]

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY")
    process.exit(1)
  }
  const admin = createClient(url, key, { auth: { persistSession: false } })

  for (const path of TEST_PATHS) {
    const filename = path.slice(path.lastIndexOf("/") + 1)
    console.log("\n" + "═".repeat(80))
    console.log("FILE:", filename)
    console.log("═".repeat(80))

    const { data: blob, error } = await admin.storage.from("submittals").download(path)
    if (error || !blob) {
      console.log("  ✗ Could not download:", error?.message)
      continue
    }
    const buf = Buffer.from(await blob.arrayBuffer())
    console.log(`  ${buf.length.toLocaleString()} bytes`)

    let pages
    try {
      pages = await extractPdfPages(buf)
    } catch (err) {
      console.log("  ✗ Could not extract text:", err.message)
      continue
    }
    console.log(`  ${pages.length} pages extracted`)

    // Per-page char count summary
    console.log("\n  Char counts per page (low = likely scanned/image):")
    pages.forEach((p, i) => {
      const c = p.replace(/\s+/g, "").length
      const tag = c < 30 ? "  ⚠ LOW-TEXT (probable scan/image, no text layer)"
        : c < 200 ? "  (sparse)"
        : ""
      console.log(`    page ${i + 1}: ${c.toString().padStart(6)} chars${tag}`)
    })

    // What the filename parser thinks
    const fnGuess = parseSectionFromFilename(filename)
    console.log(`\n  FILENAME parser: section=${JSON.stringify(fnGuess.section)} source=${fnGuess.source}`)

    // What the page-1 + page-2 readers do today
    const p1 = pages[0] ?? ""
    const p2 = pages[1] ?? ""
    const p1Section = parseSectionFromPageText(p1)
    const p2Section = parseSectionFromPageText(p2)
    console.log(`  PAGE 1 parser: section=${JSON.stringify(p1Section)}`)
    console.log(`  PAGE 2 parser: section=${JSON.stringify(p2Section)}`)
    console.log(`  → analyzePdf would pick: ${JSON.stringify(p2Section ?? p1Section ?? fnGuess.section)}`)
    console.log(`    (page-2 first, then page-1, then filename)`)

    // Coversheet template detection
    console.log(`\n  COVER TEMPLATE detection:`)
    console.log(`    page 1 looksLikeArchitectReview:    ${looksLikeArchitectReview(p1)}`)
    console.log(`    page 1 looksLikeSubmitterCoversheet:${looksLikeSubmitterCoversheet(p1)}`)
    console.log(`    page 2 looksLikeArchitectReview:    ${looksLikeArchitectReview(p2)}`)
    console.log(`    page 2 looksLikeSubmitterCoversheet:${looksLikeSubmitterCoversheet(p2)}`)

    // Probe for the actual section / division text in each of the leading pages
    for (let i = 0; i < Math.min(pages.length, 3); i++) {
      console.log(`\n  ── PAGE ${i + 1} text probes (does section/division literally appear?):`)
      const p = pages[i]
      // What text patterns match the section?
      console.log("    " + searchFor("Spec Section label",  /Spec(?:ification)?\s+Section/i, p))
      console.log("    " + searchFor("Division label",       /Division\s*(?:No\.?|#)?\s*\d{2}/i, p))
      console.log("    " + searchFor("6-digit run",          /(?<!\d)\d{6}(?!\d)/, p))
      console.log("    " + searchFor("8-digit run",          /(?<!\d)\d{8}(?!\d)/, p))
      console.log("    " + searchFor("XX XX XX pattern",     /\d{2}\s\d{2}\s\d{2}/, p))
    }

    // Show first 600 chars of pages 1+2 (raw, truncated) for the user to see.
    console.log("\n  ── PAGE 1 raw extracted text (first 600 chars):")
    console.log("    " + JSON.stringify((p1 || "").slice(0, 600)))
    console.log("\n  ── PAGE 2 raw extracted text (first 600 chars):")
    console.log("    " + JSON.stringify((p2 || "").slice(0, 600)))
  }
}

main().catch(err => { console.error(err); process.exit(1) })
