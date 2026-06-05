// Dry-run of the new spec-parser title extractor (Layer 1 + Layer 2 +
// last-resort) against project 350ee2a5's spec book. No writes — pulls
// the PDF from storage, runs the new parser locally, prints the full
// before→after diff against spec_sections.spec_title.
//
// Logic mirrors src/lib/spec-parser.ts. Keep in sync.

import { createClient } from "@supabase/supabase-js"
import { extractText, getDocumentProxy } from "unpdf"
import { readFileSync, writeFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Allow override via CLI: node scripts/spec-parser-dry-run.mjs <project_id> <doc_path>
const PROJECT_ID = process.argv[2] || "350ee2a5-49e4-4675-9826-ada407a53d3d"
const DOC_PATH   = process.argv[3] || "c7c08273-8d0a-40fd-8f67-b712955eeb47/spec-books/627ab8d2-e585-4321-bd3f-5d863c723503/0301-0509_Contract_Special_Provisions.pdf"
const OUT_FILE   = process.argv[4] || "scripts/spec-parser-dry-run-output.json"

// ────────────────────────────────────────────────────────────────────────
// Mirror of src/lib/spec-parser.ts (new logic only).
// ────────────────────────────────────────────────────────────────────────

const VALID_DIVISIONS = new Set([
  "00","01","02","03","04","05","06","07","08","09","10","11","12",
  "13","14","21","22","23","25","26","27","28","31","32","33","34",
  "35","40","41","42","43","44","46","48",
])
const DIVISION_NAMES = {
  "00":"Procurement and Contracting Requirements","01":"General Requirements","02":"Existing Conditions",
  "03":"Concrete","04":"Masonry","05":"Metals","06":"Wood, Plastics, and Composites",
  "07":"Thermal and Moisture Protection","08":"Openings","09":"Finishes","10":"Specialties","11":"Equipment",
  "12":"Furnishings","13":"Special Construction","14":"Conveying Equipment","21":"Fire Suppression",
  "22":"Plumbing","23":"Heating, Ventilating, and Air Conditioning (HVAC)","25":"Integrated Automation",
  "26":"Electrical","27":"Communications","28":"Electronic Safety and Security","31":"Earthwork",
  "32":"Exterior Improvements","33":"Utilities","34":"Transportation","35":"Waterway and Marine Construction",
  "40":"Process Interconnections","41":"Material Processing and Handling Equipment",
  "42":"Process Heating, Cooling, and Drying Equipment","43":"Process Gas and Liquid Handling, Purification, and Storage Equipment",
  "44":"Pollution and Waste Control Equipment","46":"Water and Wastewater Equipment","48":"Electrical Power Generation",
}
function divisionNameFor(n) { return DIVISION_NAMES[n.slice(0,2)] ?? "Unknown Division" }

function cleanTitle(raw) {
  return String(raw ?? "")
    .replace(/[.…]{2,}.*$/, "")
    .replace(/\s+\d{1,4}$/, "")
    .replace(/\s+/g, " ").trim().slice(0, 80)
}

// ── Mirror of smartTitleCase from src/lib/spec-parser.ts ──
const CONSTRUCTION_ACRONYMS = new Set([
  "HVAC","AHU","RTU","VAV","CAV","FCU","EPDM","PVC","CPVC","ABS","HDPE","CFM","GPM",
  "BTU","BTUH","MBH","KW","KVA","KWH","IAQ","MERV","HEPA","DDC","BAS","BMS","VFD",
  "VRF","DOAS","CRAC","FLA","RLA","MCA","MCB","COP","SEER","EER","DX",
  "NEMA","NEC","UL","AFCI","GFCI","GFI","LED","OLED","EMT","IMC","USB","POE","UPS",
  "AC","DC","KV","KVAR","RGS","MV","LV","HV","RH","CCT","CRI","IES",
  "CMU","FRP","GFRC","GRP","EIFS","PSF","PCF","PSI","OSB","MDF","LVL","PSL","OWSJ",
  "DI","HDPE","RCP","PCC","HMA","SPT","SF","CY","LF","SY","EA",
  "ASTM","ASME","ANSI","ASHRAE","NFPA","OSHA","USGBC","LEED","EPA","SSPC","AISI",
  "AISC","ACI","NOMMA","AWS","AWWA","NIST","NAAMM","TIA","EIA",
  "MEP","FFE","ADA","CCTV","DVR","NVR","ID","OD","SDS","MSDS","DAS","BDA","MCP",
  "PIR","BIM","COR","CO","ROI","RFP","RFI","NCR","AHJ","SOG","SLA",
  "TPO","EPDM","SBS","APP","PVA","BUR","KEE","BIPV","HVLP","DPM",
  "RJ45","IP","POE","NVR","DVR","WAP","SSID","VLAN","VPN","NIC","SAN","NAS","SQL",
  "GC","CM","FF","CW","HW","DDC","BAS","ATS","ARC",
])
const MINOR_WORDS = new Set(["and","or","but","of","for","the","to","a","an","in","on","at","by","with","as","is","via","per"])

function titleCaseWord(word, isFirstInTitle) {
  if (!word) return word
  const m = word.match(/^([^A-Za-z0-9]*)([A-Za-z0-9]+(?:'[A-Za-z]+)?)([^A-Za-z0-9]*)$/)
  if (!m) return word
  const [, leading, core, trailing] = m
  if (CONSTRUCTION_ACRONYMS.has(core.toUpperCase())) return leading + core.toUpperCase() + trailing
  if (/^\d/.test(core)) return leading + core + trailing
  if (!isFirstInTitle && MINOR_WORDS.has(core.toLowerCase())) return leading + core.toLowerCase() + trailing
  return leading + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + trailing
}
function smartTitleCase(input) {
  if (!input) return input
  const tokens = input.split(/(\s+)/)
  let isFirstWord = true
  return tokens.map(token => {
    if (/^\s+$/.test(token) || token === "") return token
    if (token.includes("-")) {
      const parts = token.split("-")
      const t = parts.map((p, i) => titleCaseWord(p, isFirstWord && i === 0))
      isFirstWord = false
      return t.join("-")
    }
    if (token.includes("/")) {
      const parts = token.split("/")
      const t = parts.map((p, i) => titleCaseWord(p, isFirstWord && i === 0))
      isFirstWord = false
      return t.join("/")
    }
    const out = titleCaseWord(token, isFirstWord)
    isFirstWord = false
    return out
  }).join("")
}
function stripQuotesAndPunctuation(raw) {
  return String(raw ?? "")
    .replace(/^[\s"“”'',./\-–—]+/, "")
    .replace(/[\s"“”'',.;:]+$/, "")
    .trim()
}
const BODY_FRAGMENT_PATTERNS = [
  /^PART\s+\d/i,
  /^\d+\.\d+(?:\.\d+)?\s/,
  /^\d+\.\s/,
  /^[A-Z]\.\s/,
]
const isBodyFragment = t => BODY_FRAGMENT_PATTERNS.some(re => re.test(t))
const letterCount = s => String(s ?? "").replace(/[^A-Za-z]/g, "").length
function validateTitle(raw) {
  if (!raw) return null
  const c = cleanTitle(stripQuotesAndPunctuation(raw))
  if (letterCount(c) < 3) return null
  if (isBodyFragment(c)) return null
  return c
}

const STRICT_HEADER_LINE = /^\s*SECTION\s+(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?\s*[-–—:]\s*(.+)$/i
const SAME_LINE_HEADER   = /^\s*(?:SECTION\s+)?(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?\s*(?:[-–—:]\s*)?(.*)$/i

function findCandidatesInPage(pageText, page, pageStartOffset) {
  const out = []
  const lines = pageText.split("\n")
  let offsetInPage = 0
  for (let i = 0; i < lines.length; i++) {
    const lineOffset = offsetInPage
    offsetInPage += lines[i].length + 1

    // Tier 0 — strict
    const strict = lines[i].match(STRICT_HEADER_LINE)
    if (strict && VALID_DIVISIONS.has(strict[1])) {
      const specNumber = `${strict[1]} ${strict[2]} ${strict[3]}`
      if (specNumber !== "00 00 00") {
        const title = validateTitle(strict[4] ?? "")
        if (title !== null) {
          out.push({ specNumber, specTitle: title, tier: "section-prefix", page, globalOffset: pageStartOffset + lineOffset })
          continue
        }
      }
    }

    // Tier 1+ — loose
    const m = lines[i].match(SAME_LINE_HEADER)
    if (!m) continue
    const div = m[1]
    if (!VALID_DIVISIONS.has(div)) continue
    const specNumber = `${m[1]} ${m[2]} ${m[3]}`
    if (specNumber === "00 00 00") continue
    const sameLineValid = validateTitle(m[4] ?? "")
    let title = ""
    let tier
    if (sameLineValid !== null) {
      title = sameLineValid
      tier = "bare-same-line"
    } else {
      let lookahead = null
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const next = lines[j].trim()
        if (letterCount(next) < 3) continue
        lookahead = validateTitle(next)
        break
      }
      if (lookahead !== null) { title = lookahead; tier = "lookahead" }
      else                    { title = "";        tier = "no-clean-title" }
    }
    out.push({ specNumber, specTitle: title, tier, page, globalOffset: pageStartOffset + lineOffset })
  }
  return out
}

const TIER_RANK = { "section-prefix":0, "bare-same-line":1, "lookahead":2, "no-clean-title":3 }
function dedupeByTierThenGap(all, totalChars) {
  const ordered = [...all].sort((a, b) => a.globalOffset - b.globalOffset)
  const gaps = ordered.map((c, i) =>
    (i + 1 < ordered.length ? ordered[i+1].globalOffset : totalChars) - c.globalOffset)
  const grouped = new Map()
  for (let i = 0; i < ordered.length; i++) {
    const arr = grouped.get(ordered[i].specNumber) ?? []
    arr.push({ cand: ordered[i], gap: gaps[i] })
    grouped.set(ordered[i].specNumber, arr)
  }
  const picked = []
  for (const arr of grouped.values()) {
    let bestTier = Infinity
    for (const e of arr) bestTier = Math.min(bestTier, TIER_RANK[e.cand.tier])
    const inBest = arr.filter(e => TIER_RANK[e.cand.tier] === bestTier)
    let best = inBest[0]
    for (const e of inBest) if (e.gap > best.gap) best = e
    picked.push(best.cand)
  }
  return picked.sort((a, b) => a.globalOffset - b.globalOffset)
}

const FOOTER_TITLE_RE =
  /\n\s*([A-Z][A-Z\s\-/&,]{4,80}|[A-Z][A-Za-z][A-Za-z\s\-/&,]{4,80})\s*\n\s*Project\s+No\.?/
function extractFooterTitle(fullText) {
  if (!fullText) return null
  const m = fullText.match(FOOTER_TITLE_RE)
  if (!m) return null
  const c = cleanTitle(stripQuotesAndPunctuation(m[1]))
  if (letterCount(c) < 3) return null
  if (isBodyFragment(c)) return null
  return c
}

// ────────────────────────────────────────────────────────────────────────
// Run.
// ────────────────────────────────────────────────────────────────────────

console.log("Downloading spec book PDF…")
const { data: blob, error: dlErr } = await a.storage.from("submittals").download(DOC_PATH)
if (dlErr) { console.error("download error:", dlErr.message); process.exit(1) }
const buffer = Buffer.from(await blob.arrayBuffer())
console.log("Extracting text from", buffer.length, "bytes …")
const pdf = await getDocumentProxy(new Uint8Array(buffer))
const { text } = await extractText(pdf, { mergePages: false })
const pages = Array.isArray(text) ? text : [text]
console.log("Pages:", pages.length)

const pageStartOffsets = []
let acc = 0
for (const p of pages) { pageStartOffsets.push(acc); acc += p.length + 1 }
const totalChars = acc

const perPage = pages.map((p, i) => findCandidatesInPage(p, i + 1, pageStartOffsets[i]))
// detectTocRegion — mirror simplified
const TOC_DENSITY = 4, TOC_SEARCH_FRAC = 0.3
function detectTocRegion(perPage, pageCount) {
  const limit = Math.min(pageCount, Math.max(1, Math.ceil(pageCount * TOC_SEARCH_FRAC)))
  let bestStart=-1,bestEnd=-1,bestCount=0,runStart=-1,runCount=0
  const close = (endEx) => { if (runStart !== -1 && runCount > bestCount){bestStart=runStart;bestEnd=endEx-1;bestCount=runCount}; runStart=-1; runCount=0 }
  for (let i = 0; i < limit; i++) {
    if (perPage[i].length >= TOC_DENSITY) { if (runStart === -1) runStart=i; runCount += perPage[i].length }
    else close(i)
  }
  close(limit)
  return bestStart !== -1 ? { start: bestStart, end: bestEnd } : null
}
const toc = detectTocRegion(perPage, pages.length)
const all = []
for (let i = 0; i < perPage.length; i++) {
  if (toc && i >= toc.start && i <= toc.end) continue
  all.push(...perPage[i])
}
console.log("Candidates:", all.length, "(TOC region:", toc, ")")

const headers = dedupeByTierThenGap(all, totalChars)
console.log("Sections after dedupe:", headers.length)

const docText = pages.join("\n")
const sections = headers.map((h, i) => {
  const startOff = h.globalOffset
  const endOff = i + 1 < headers.length ? headers[i+1].globalOffset : docText.length
  const fullText = docText.slice(startOff, endOff)
  let specTitle = h.specTitle
  let titleSource = h.tier === "section-prefix" ? "section-prefix" :
                    h.tier === "bare-same-line" ? "bare-same-line" :
                    h.tier === "lookahead"      ? "lookahead" : "masterformat-fallback"
  let needsReview = false
  if (h.tier === "no-clean-title" || specTitle === "") {
    const ft = extractFooterTitle(fullText)
    if (ft !== null) { specTitle = ft; titleSource = "footer-pattern" }
    else { specTitle = divisionNameFor(h.specNumber); titleSource = "masterformat-fallback"; needsReview = true }
  }
  if (titleSource !== "masterformat-fallback") {
    specTitle = smartTitleCase(specTitle)
  }
  return { specNumber: h.specNumber, newTitle: specTitle, titleSource, needsReview, startPage: h.page }
})

// Load current titles for diff
console.log("Loading current spec_sections.spec_title …")
const { data: current, error: cErr } = await a
  .from("spec_sections").select("spec_number, spec_title")
  .eq("project_id", PROJECT_ID)
if (cErr) { console.error(cErr.message); process.exit(1) }
const currentBy = new Map(current.map(r => [r.spec_number, r.spec_title]))

// Compute diff
const diff = []
let changed = 0, same = 0, addedByExtractor = 0, removedByExtractor = 0
const seenNew = new Set()
for (const s of sections) {
  seenNew.add(s.specNumber)
  const cur = currentBy.get(s.specNumber)
  if (cur === undefined) { addedByExtractor++; diff.push({ specNumber: s.specNumber, before: "(not in current parse)", after: s.newTitle, source: s.titleSource, needsReview: s.needsReview, status: "ADDED" }); continue }
  if (cur === s.newTitle) { same++; continue }
  changed++
  diff.push({ specNumber: s.specNumber, before: cur, after: s.newTitle, source: s.titleSource, needsReview: s.needsReview, status: "CHANGED" })
}
for (const r of current) {
  if (!seenNew.has(r.spec_number)) {
    removedByExtractor++
    diff.push({ specNumber: r.spec_number, before: r.spec_title, after: "(not in new parse)", source: "n/a", needsReview: false, status: "REMOVED" })
  }
}

console.log("\n────────── SUMMARY ──────────")
console.log("Unchanged:", same)
console.log("Changed:  ", changed)
console.log("Added:    ", addedByExtractor)
console.log("Removed:  ", removedByExtractor)
console.log("Total NEW sections:", sections.length)
console.log("Total OLD sections:", current.length)

// Validation against known good + bad
const VALIDATE_BAD = ["06 10 00","09 22 16","09 65 13","09 67 23","09 91 00"]
const VALIDATE_GOOD = ["07 92 00","03 30 00","23 21 13"]
console.log("\n────── VALIDATION: known-bad sections (should now extract real title) ──────")
for (const n of VALIDATE_BAD) {
  const after = sections.find(s => s.specNumber === n)
  const before = currentBy.get(n)
  console.log(`  ${n}: before=${JSON.stringify(before)}  after=${JSON.stringify(after?.newTitle)}  source=${after?.titleSource}  review=${after?.needsReview}`)
}
console.log("\n────── VALIDATION: known-good sections (must stay correct) ──────")
for (const n of VALIDATE_GOOD) {
  const after = sections.find(s => s.specNumber === n)
  const before = currentBy.get(n)
  console.log(`  ${n}: before=${JSON.stringify(before)}  after=${JSON.stringify(after?.newTitle)}  source=${after?.titleSource}`)
}

console.log("\n────────── FULL DIFF (changed only) ──────────")
diff.filter(d => d.status === "CHANGED").sort((a, b) => a.specNumber.localeCompare(b.specNumber)).forEach(d => {
  console.log(`  ${d.specNumber}  [${d.source}]  before: ${JSON.stringify(d.before)}\n             after:  ${JSON.stringify(d.after)}${d.needsReview ? "  (needs review)" : ""}`)
})

if (addedByExtractor > 0 || removedByExtractor > 0) {
  console.log("\n────────── ADDED / REMOVED ──────────")
  diff.filter(d => d.status !== "CHANGED").forEach(d => {
    console.log(`  ${d.status.padEnd(8)}  ${d.specNumber}  ${d.before} → ${d.after}`)
  })
}

writeFileSync(OUT_FILE, JSON.stringify({
  project_id: PROJECT_ID,
  summary: { same, changed, addedByExtractor, removedByExtractor, totalNew: sections.length, totalOld: current.length },
  diff,
  sections: sections.map(s => ({ specNumber: s.specNumber, newTitle: s.newTitle, titleSource: s.titleSource, needsReview: s.needsReview })),
}, null, 2))
console.log("\nFull JSON saved to", OUT_FILE)
