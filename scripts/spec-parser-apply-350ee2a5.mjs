// One-time apply of the new parser titles to project 350ee2a5.
// Mirrors src/lib/spec-parser.ts (same Layer 1 + Layer 2 + last-resort
// + smart Title Case). Reads the PDF from storage, parses with new
// rules, then:
//   1) UPDATE spec_sections.spec_title + needs_title_review per row
//   2) UPDATE submittals.file_name + received_file_name via the
//      spec_section_id FK for spec_ingestion-sourced active rows
// Reports counts at the end.

import { createClient } from "@supabase/supabase-js"
import { extractText, getDocumentProxy } from "unpdf"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PROJECT_ID = "350ee2a5-49e4-4675-9826-ada407a53d3d"
const DOC_PATH   = "c7c08273-8d0a-40fd-8f67-b712955eeb47/spec-books/627ab8d2-e585-4321-bd3f-5d863c723503/0301-0509_Contract_Special_Provisions.pdf"

// ── Mirror of parser logic (Layer 1 + Layer 2 + last-resort + Title Case) ──

const VALID_DIVISIONS = new Set([
  "00","01","02","03","04","05","06","07","08","09","10","11","12",
  "13","14","21","22","23","25","26","27","28","31","32","33","34",
  "35","40","41","42","43","44","46","48",
])
const DIVISION_NAMES = {
  "00":"Procurement and Contracting Requirements","01":"General Requirements","02":"Existing Conditions","03":"Concrete","04":"Masonry","05":"Metals","06":"Wood, Plastics, and Composites","07":"Thermal and Moisture Protection","08":"Openings","09":"Finishes","10":"Specialties","11":"Equipment","12":"Furnishings","13":"Special Construction","14":"Conveying Equipment","21":"Fire Suppression","22":"Plumbing","23":"Heating, Ventilating, and Air Conditioning (HVAC)","25":"Integrated Automation","26":"Electrical","27":"Communications","28":"Electronic Safety and Security","31":"Earthwork","32":"Exterior Improvements","33":"Utilities","34":"Transportation","35":"Waterway and Marine Construction","40":"Process Interconnections","41":"Material Processing and Handling Equipment","42":"Process Heating, Cooling, and Drying Equipment","43":"Process Gas and Liquid Handling, Purification, and Storage Equipment","44":"Pollution and Waste Control Equipment","46":"Water and Wastewater Equipment","48":"Electrical Power Generation",
}
const divisionNameFor = n => DIVISION_NAMES[n.slice(0,2)] ?? "Unknown Division"
const cleanTitle = raw => String(raw ?? "").replace(/[.…]{2,}.*$/, "").replace(/\s+\d{1,4}$/, "").replace(/\s+/g, " ").trim().slice(0, 80)
const stripQuotesAndPunctuation = raw => String(raw ?? "").replace(/^[\s"“”'',./\-–—]+/, "").replace(/[\s"“”'',.;:]+$/, "").trim()
const BODY_FRAGMENT = [/^PART\s+\d/i, /^\d+\.\d+(?:\.\d+)?\s/, /^\d+\.\s/, /^[A-Z]\.\s/]
const isBodyFragment = t => BODY_FRAGMENT.some(re => re.test(t))
const letterCount = s => String(s ?? "").replace(/[^A-Za-z]/g, "").length
function validateTitle(raw) {
  if (!raw) return null
  const c = cleanTitle(stripQuotesAndPunctuation(raw))
  if (letterCount(c) < 3 || isBodyFragment(c)) return null
  return c
}

const CONSTRUCTION_ACRONYMS = new Set([
  "HVAC","AHU","RTU","VAV","CAV","FCU","EPDM","PVC","CPVC","ABS","HDPE","CFM","GPM","BTU","BTUH","MBH","KW","KVA","KWH","IAQ","MERV","HEPA","DDC","BAS","BMS","VFD","VRF","DOAS","CRAC","FLA","RLA","MCA","MCB","COP","SEER","EER","DX",
  "NEMA","NEC","UL","AFCI","GFCI","GFI","LED","OLED","EMT","IMC","USB","POE","UPS","AC","DC","KV","KVAR","RGS","MV","LV","HV","RH","CCT","CRI","IES",
  "CMU","FRP","GFRC","GRP","EIFS","PSF","PCF","PSI","OSB","MDF","LVL","PSL","OWSJ","DI","HDPE","RCP","PCC","HMA","SPT","SF","CY","LF","SY","EA",
  "ASTM","ASME","ANSI","ASHRAE","NFPA","OSHA","USGBC","LEED","EPA","SSPC","AISI","AISC","ACI","NOMMA","AWS","AWWA","NIST","NAAMM","TIA","EIA",
  "MEP","FFE","ADA","CCTV","DVR","NVR","ID","OD","SDS","MSDS","DAS","BDA","MCP","PIR","BIM","COR","CO","ROI","RFP","RFI","NCR","AHJ","SOG","SLA",
  "TPO","EPDM","SBS","APP","PVA","BUR","KEE","BIPV","HVLP","DPM",
  "RJ45","IP","POE","NVR","DVR","WAP","SSID","VLAN","VPN","NIC","SAN","NAS","SQL",
  "GC","CM","FF","CW","HW","DDC","BAS","ATS","ARC",
])
const MINOR_WORDS = new Set(["and","or","but","of","for","the","to","a","an","in","on","at","by","with","as","is","via","per"])
function titleCaseWord(word, isFirst) {
  if (!word) return word
  const m = word.match(/^([^A-Za-z0-9]*)([A-Za-z0-9]+(?:'[A-Za-z]+)?)([^A-Za-z0-9]*)$/)
  if (!m) return word
  const [, l, c, t] = m
  if (CONSTRUCTION_ACRONYMS.has(c.toUpperCase())) return l + c.toUpperCase() + t
  if (/^\d/.test(c)) return l + c + t
  if (!isFirst && MINOR_WORDS.has(c.toLowerCase())) return l + c.toLowerCase() + t
  return l + c.charAt(0).toUpperCase() + c.slice(1).toLowerCase() + t
}
function smartTitleCase(input) {
  if (!input) return input
  const tokens = input.split(/(\s+)/)
  let first = true
  return tokens.map(tok => {
    if (/^\s+$/.test(tok) || tok === "") return tok
    if (tok.includes("-")) { const p = tok.split("-").map((x,i) => titleCaseWord(x, first && i===0)); first = false; return p.join("-") }
    if (tok.includes("/")) { const p = tok.split("/").map((x,i) => titleCaseWord(x, first && i===0)); first = false; return p.join("/") }
    const out = titleCaseWord(tok, first); first = false; return out
  }).join("")
}

const STRICT_HEADER_LINE = /^\s*SECTION\s+(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?\s*[-–—:]\s*(.+)$/i
const SAME_LINE_HEADER   = /^\s*(?:SECTION\s+)?(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?\s*(?:[-–—:]\s*)?(.*)$/i

function findCandidatesInPage(pageText, page, pageStartOffset) {
  const out = []
  const lines = pageText.split("\n")
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    const lo = off
    off += lines[i].length + 1
    const strict = lines[i].match(STRICT_HEADER_LINE)
    if (strict && VALID_DIVISIONS.has(strict[1])) {
      const sn = `${strict[1]} ${strict[2]} ${strict[3]}`
      if (sn !== "00 00 00") {
        const t = validateTitle(strict[4] ?? "")
        if (t !== null) { out.push({ specNumber: sn, specTitle: t, tier: "section-prefix", page, globalOffset: pageStartOffset + lo }); continue }
      }
    }
    const m = lines[i].match(SAME_LINE_HEADER)
    if (!m) continue
    if (!VALID_DIVISIONS.has(m[1])) continue
    const sn = `${m[1]} ${m[2]} ${m[3]}`
    if (sn === "00 00 00") continue
    const sv = validateTitle(m[4] ?? "")
    let title = ""
    let tier
    if (sv !== null) { title = sv; tier = "bare-same-line" }
    else {
      let la = null
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const next = lines[j].trim()
        if (letterCount(next) < 3) continue
        la = validateTitle(next)
        break
      }
      if (la !== null) { title = la; tier = "lookahead" }
      else             { title = "";  tier = "no-clean-title" }
    }
    out.push({ specNumber: sn, specTitle: title, tier, page, globalOffset: pageStartOffset + lo })
  }
  return out
}

const TIER_RANK = { "section-prefix":0, "bare-same-line":1, "lookahead":2, "no-clean-title":3 }
function dedupeByTierThenGap(all, total) {
  const ordered = [...all].sort((a, b) => a.globalOffset - b.globalOffset)
  const gaps = ordered.map((c, i) => (i + 1 < ordered.length ? ordered[i+1].globalOffset : total) - c.globalOffset)
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

const FOOTER_TITLE_RE = /\n\s*([A-Z][A-Z\s\-/&,]{4,80}|[A-Z][A-Za-z][A-Za-z\s\-/&,]{4,80})\s*\n\s*Project\s+No\.?/
function extractFooterTitle(fullText) {
  if (!fullText) return null
  const m = fullText.match(FOOTER_TITLE_RE)
  if (!m) return null
  const c = cleanTitle(stripQuotesAndPunctuation(m[1]))
  if (letterCount(c) < 3 || isBodyFragment(c)) return null
  return c
}

// ── Run ───────────────────────────────────────────────────────────────────

console.log("Downloading spec book…")
const { data: blob, error: dlErr } = await a.storage.from("submittals").download(DOC_PATH)
if (dlErr) { console.error(dlErr.message); process.exit(1) }
const buffer = Buffer.from(await blob.arrayBuffer())
const pdf = await getDocumentProxy(new Uint8Array(buffer))
const { text } = await extractText(pdf, { mergePages: false })
const pages = Array.isArray(text) ? text : [text]
console.log("Pages:", pages.length)

const pageStartOffsets = []
let acc = 0
for (const p of pages) { pageStartOffsets.push(acc); acc += p.length + 1 }
const total = acc

const perPage = pages.map((p, i) => findCandidatesInPage(p, i + 1, pageStartOffsets[i]))
const TOC_DENSITY = 4, TOC_SEARCH_FRAC = 0.3
function detectTocRegion(perPage, pc) {
  const limit = Math.min(pc, Math.max(1, Math.ceil(pc * TOC_SEARCH_FRAC)))
  let bs=-1,be=-1,bc=0,rs=-1,rc=0
  const close = (e) => { if (rs !== -1 && rc > bc){bs=rs;be=e-1;bc=rc}; rs=-1; rc=0 }
  for (let i = 0; i < limit; i++) {
    if (perPage[i].length >= TOC_DENSITY) { if (rs === -1) rs=i; rc += perPage[i].length }
    else close(i)
  }
  close(limit)
  return bs !== -1 ? { start: bs, end: be } : null
}
const toc = detectTocRegion(perPage, pages.length)
const all = []
for (let i = 0; i < perPage.length; i++) {
  if (toc && i >= toc.start && i <= toc.end) continue
  all.push(...perPage[i])
}
const headers = dedupeByTierThenGap(all, total)
console.log("Sections after dedupe:", headers.length)

const docText = pages.join("\n")
const newSections = headers.map((h, i) => {
  const startOff = h.globalOffset
  const endOff = i + 1 < headers.length ? headers[i+1].globalOffset : docText.length
  const fullText = docText.slice(startOff, endOff)
  let specTitle = h.specTitle
  let needsReview = false
  let titleSource = h.tier === "section-prefix" ? "section-prefix" : h.tier === "bare-same-line" ? "bare-same-line" : h.tier === "lookahead" ? "lookahead" : "masterformat-fallback"
  if (h.tier === "no-clean-title" || specTitle === "") {
    const ft = extractFooterTitle(fullText)
    if (ft !== null) { specTitle = ft; titleSource = "footer-pattern" }
    else { specTitle = divisionNameFor(h.specNumber); titleSource = "masterformat-fallback"; needsReview = true }
  }
  if (titleSource !== "masterformat-fallback") specTitle = smartTitleCase(specTitle)
  return { specNumber: h.specNumber, newTitle: specTitle, needsReview }
})

// Pull existing rows
console.log("Loading existing spec_sections…")
const { data: existing, error: eErr } = await a
  .from("spec_sections")
  .select("id, spec_number, spec_title, needs_title_review")
  .eq("project_id", PROJECT_ID)
if (eErr) { console.error(eErr.message); process.exit(1) }
const existingBy = new Map(existing.map(r => [r.spec_number, r]))

// Apply: update existing rows whose title or needs_title_review changes
const sectionTitleById = new Map()
let sectionsUpdated = 0
let sectionsAdded   = 0  // adds are NOT auto-created — surface count only
let sectionsUnchanged = 0
for (const s of newSections) {
  const cur = existingBy.get(s.specNumber)
  if (!cur) { sectionsAdded++; continue }
  const titleChanged = cur.spec_title !== s.newTitle
  const reviewChanged = (cur.needs_title_review ?? false) !== s.needsReview
  if (!titleChanged && !reviewChanged) { sectionsUnchanged++; continue }
  const { error: uErr } = await a
    .from("spec_sections")
    .update({ spec_title: s.newTitle, needs_title_review: s.needsReview })
    .eq("id", cur.id)
  if (uErr) { console.error("update spec_sections", s.specNumber, uErr.message); continue }
  sectionTitleById.set(cur.id, s.newTitle)
  sectionsUpdated++
}

// Propagate titles to submittals
console.log("Propagating titles to submittals…")
let submittalsUpdated = 0
if (sectionTitleById.size > 0) {
  const { data: subs, error: sErr } = await a
    .from("submittals")
    .select("id, spec_section_id, file_name")
    .eq("project_id", PROJECT_ID)
    .eq("source", "spec_ingestion")
    .neq("status", "deleted")
    .in("spec_section_id", [...sectionTitleById.keys()])
  if (sErr) { console.error(sErr.message); process.exit(1) }
  for (const row of subs ?? []) {
    const t = sectionTitleById.get(row.spec_section_id)
    if (!t || t === row.file_name) continue
    const { error: uErr } = await a
      .from("submittals")
      .update({ file_name: t, received_file_name: t })
      .eq("id", row.id)
      .eq("source", "spec_ingestion")
      .neq("status", "deleted")
    if (uErr) { console.error("update submittals", row.id, uErr.message); continue }
    submittalsUpdated++
  }
}

const needsReviewCount = newSections.filter(s => s.needsReview).length

console.log("\n════ RESULT ════")
console.log("Sections in PDF:        ", newSections.length)
console.log("  unchanged:            ", sectionsUnchanged)
console.log("  updated:              ", sectionsUpdated)
console.log("  added (not auto-create):", sectionsAdded)
console.log("Submittals updated:     ", submittalsUpdated)
console.log("needs_title_review set: ", needsReviewCount)
