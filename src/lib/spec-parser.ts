import { extractText, getDocumentProxy } from "unpdf"
import type { TocEntry, TocDivision } from "@/lib/scope-types"

export type { TocEntry, TocDivision }

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedSection {
  specNumber: string      // normalized "06 10 00"
  specTitle: string       // "Rough Carpentry"
  startPage: number       // 1-based
  endPage: number         // 1-based, inclusive
  fullText: string
  submittalsText: string  // concatenated SUBMITTALS-type articles, "" if none
  /** True when Layer 1 (section-prefix + body-fragment guard) and Layer 2
   *  (footer-pattern fallback) both failed to find a clean title and the
   *  MasterFormat division name was used as a last-resort label. The
   *  spec-book + Library views surface this so the user knows to set the
   *  title manually for these rare cases. NEVER set true silently — a
   *  clean Layer 1 / Layer 2 title clears this flag. */
  needsTitleReview: boolean
  /** Provenance of the title — useful for diagnostics + the dry-run
   *  comparison view. */
  titleSource: "section-prefix" | "header-block" | "bare-same-line" | "lookahead" | "footer-pattern" | "masterformat-fallback" | "toc-enriched"
  /** True when this boundary's spec number is NOT present in the book's table
   *  of contents (Layer 2 validation). Surfaced for review; never blocks a
   *  commit and never removes the boundary. */
  notInToc?: boolean
}

export interface SpecParseResult {
  pageCount: number
  totalChars: number
  needsOcr: boolean       // true when there is essentially no extractable text layer
  sections: ParsedSection[]
}

// ─── MasterFormat reference data ─────────────────────────────────────────────

// Division numbers that actually exist in MasterFormat. Used to reject the many
// six-digit sequences in a spec book that are not section numbers (dates, part
// numbers, dimensions, etc.).
const VALID_DIVISIONS = new Set([
  "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12",
  "13", "14", "21", "22", "23", "25", "26", "27", "28", "31", "32", "33", "34",
  "35", "40", "41", "42", "43", "44", "46", "48",
])

export const DIVISION_NAMES: Record<string, string> = {
  "00": "Procurement and Contracting Requirements",
  "01": "General Requirements",
  "02": "Existing Conditions",
  "03": "Concrete",
  "04": "Masonry",
  "05": "Metals",
  "06": "Wood, Plastics, and Composites",
  "07": "Thermal and Moisture Protection",
  "08": "Openings",
  "09": "Finishes",
  "10": "Specialties",
  "11": "Equipment",
  "12": "Furnishings",
  "13": "Special Construction",
  "14": "Conveying Equipment",
  "21": "Fire Suppression",
  "22": "Plumbing",
  "23": "Heating, Ventilating, and Air Conditioning (HVAC)",
  "25": "Integrated Automation",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic Safety and Security",
  "31": "Earthwork",
  "32": "Exterior Improvements",
  "33": "Utilities",
  "34": "Transportation",
  "35": "Waterway and Marine Construction",
  "40": "Process Interconnections",
  "41": "Material Processing and Handling Equipment",
  "42": "Process Heating, Cooling, and Drying Equipment",
  "43": "Process Gas and Liquid Handling, Purification, and Storage Equipment",
  "44": "Pollution and Waste Control Equipment",
  "46": "Water and Wastewater Equipment",
  "48": "Electrical Power Generation",
}

export function divisionNumberOf(specNumber: string): string {
  return specNumber.slice(0, 2)
}

export function divisionNameFor(specNumber: string): string {
  return DIVISION_NAMES[divisionNumberOf(specNumber)] ?? "Unknown Division"
}

// ─── PDF text extraction ─────────────────────────────────────────────────────

/** Returns one string per page (1-based by array index + 1). */
export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  return Array.isArray(text) ? text : [text]
}

// ─── Section detection ───────────────────────────────────────────────────────
//
// Title extraction is tiered (Layer 1) so a genuine `SECTION NNNNNN — TITLE`
// header always beats page-header noise (`NNNNNN - <pgnum>`) that repeats
// throughout the section's body. Body-fragment titles ("3.2 PREPARATION",
// "PART 3 - EXECUTION", "1. SSPC-Sp 2.", "B. Fire-Retardant…") are rejected
// outright — never kept as a title. When Layer 1 fails to find a clean
// title for a section, parseSpecBook falls back to Layer 2 (footer pattern,
// the spec-book-page-bottom `\n<TITLE>\nProject No.` shape), and finally
// to the MasterFormat division name with needsTitleReview=true.

type TitleTier =
  | "section-prefix"   // line literally contains "SECTION" keyword + clean title (best)
  | "header-block"     // title ANCHORED to the on-page SECTION line (structural, trusted)
  | "bare-same-line"   // bare number + clean title on same line
  | "lookahead"        // bare number + clean title on the next non-blank line
  | "header-scan"      // un-anchored top-block scrape (no SECTION/DOCUMENT line to
                       //   anchor to) — low confidence: loses to an anchored header,
                       //   beats a lookahead, and is always handed to review
  | "running-header"   // number changed in the running header; no body text (scanned)
  | "no-clean-title"   // candidate exists but no clean title — anchor only

interface Candidate {
  specNumber: string
  specTitle: string     // "" when tier === "no-clean-title"
  tier: TitleTier
  page: number          // 1-based
  globalOffset: number  // char offset across the whole document
}

/** Strips TOC dot-leaders and trailing page numbers, collapses whitespace. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[.…]{2,}.*$/, "")  // "ROUGH CARPENTRY ...... 5"
    .replace(/\s+\d{1,4}$/, "")        // trailing page number
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}

// ─── Smart Title Case ───────────────────────────────────────────────────────
//
// Construction acronyms preserved in caps; minor words lowercased when
// not first; hyphenated compounds title-cased per-part with minor-word
// rules; numbers/leading-digit tokens passthrough unchanged.

const CONSTRUCTION_ACRONYMS = new Set([
  // Mechanical / HVAC
  "HVAC","AHU","RTU","VAV","CAV","FCU","EPDM","PVC","CPVC","ABS","HDPE","CFM","GPM",
  "BTU","BTUH","MBH","KW","KVA","KWH","IAQ","MERV","HEPA","DDC","BAS","BMS","VFD",
  "VRF","DOAS","CRAC","FLA","RLA","MCA","MCB","COP","SEER","EER","DX",
  // Electrical
  "NEMA","NEC","UL","AFCI","GFCI","GFI","LED","OLED","EMT","IMC","USB","POE","UPS",
  "AC","DC","KV","KVAR","RGS","MV","LV","HV","RH","CCT","CRI","IES",
  // Structural / civil
  "CMU","FRP","GFRC","GRP","EIFS","PSF","PCF","PSI","OSB","MDF","LVL","PSL","OWSJ",
  "DI","HDPE","RCP","PCC","HMA","SPT","SF","CY","LF","SY","EA",
  // Standards / agencies
  "ASTM","ASME","ANSI","ASHRAE","NFPA","OSHA","USGBC","LEED","EPA","SSPC","AISI",
  "AISC","ACI","NOMMA","AWS","AWWA","NIST","NAAMM","TIA","EIA",
  // Misc construction
  "MEP","FFE","ADA","CCTV","DVR","NVR","ID","OD","SDS","MSDS","DAS","BDA","MCP",
  "PIR","BIM","COR","CO","ROI","RFP","RFI","NCR","AHJ","SOG","SLA",
  // Building / envelope
  "TPO","EPDM","SBS","APP","PVA","BUR","KEE","BIPV","HVLP","DPM",
  // Comm / IT
  "RJ45","IP","POE","NVR","DVR","WAP","SSID","VLAN","VPN","NIC","SAN","NAS","SQL",
  // Misc industry
  "GC","CM","FF","CW","HW","DDC","BAS","ATS","ARC",
])

const MINOR_WORDS = new Set([
  "and","or","but","of","for","the","to","a","an","in","on","at","by","with",
  "as","is","via","per",
])

/** Title-case a single word, honoring the acronym list and minor-word
 *  rules. Leading/trailing punctuation passes through unchanged. */
function titleCaseWord(word: string, isFirstInTitle: boolean): string {
  if (!word) return word
  const m = word.match(/^([^A-Za-z0-9]*)([A-Za-z0-9]+(?:'[A-Za-z]+)?)([^A-Za-z0-9]*)$/)
  if (!m) return word
  const [, leading, core, trailing] = m

  // Explicit acronym list (case-insensitive lookup)
  if (CONSTRUCTION_ACRONYMS.has(core.toUpperCase())) {
    return leading + core.toUpperCase() + trailing
  }
  // Numbers / mixed (e.g. "3M", "0.0190", "0301-0509") pass through
  if (/^\d/.test(core)) return leading + core + trailing
  // Minor word: lowercase when not first in the title
  if (!isFirstInTitle && MINOR_WORDS.has(core.toLowerCase())) {
    return leading + core.toLowerCase() + trailing
  }
  // Default Title Case
  return leading + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + trailing
}

/** Apply smart Title Case to a complete title.
 *
 *  Rules:
 *    - Preserve construction acronyms in caps (HVAC, EPDM, CMU, …).
 *    - Lowercase minor words (and, of, for, …) when not the first word
 *      OR the first word of a hyphenated compound that isn't the first
 *      word of the overall title.
 *    - Hyphenated compounds title-case per part, retaining hyphens
 *      ("Cast-in-Place", "Non-Structural", "Sound-Absorbing").
 *    - Slash-separated phrases ("Hangers/Supports") title-case per part.
 *    - Numbers and tokens starting with digits pass through unchanged.
 *
 *  When the input contains MIXED case (signal that the spec book already
 *  hand-cased the title), still apply the rules — this normalizes mixed
 *  results from quote-strip cases too, and matches the user's request
 *  for Title Case output across the project.
 */
export function smartTitleCase(input: string): string {
  if (!input) return input
  // Split into runs of whitespace + words. Capturing group preserves the
  // whitespace tokens so we can re-join with original spacing.
  const tokens = input.split(/(\s+)/)
  let isFirstWord = true
  return tokens.map(token => {
    if (/^\s+$/.test(token) || token === "") return token
    // Hyphenated compound — title-case each piece with minor-word rules.
    // Only the FIRST piece of the FIRST overall word respects isFirstWord.
    if (token.includes("-")) {
      const parts = token.split("-")
      const titled = parts.map((p, i) =>
        titleCaseWord(p, isFirstWord && i === 0),
      )
      isFirstWord = false
      return titled.join("-")
    }
    // Slash-separated — same treatment as hyphens
    if (token.includes("/")) {
      const parts = token.split("/")
      const titled = parts.map((p, i) =>
        titleCaseWord(p, isFirstWord && i === 0),
      )
      isFirstWord = false
      return titled.join("/")
    }
    const out = titleCaseWord(token, isFirstWord)
    isFirstWord = false
    return out
  }).join("")
}

/** Strip surrounding quotes (straight + curly), leading punctuation
 *  (commas, periods, slashes, dashes), and trailing punctuation from a
 *  title. Cross-references in spec bodies read like
 *  `Section 079200 "Joint Sealants."` (trailing punct) or
 *  `Section 071605, "Water Vapor…"` (leading comma+quote slipping into
 *  the captured title). Without this the parser surfaces titles like
 *  `', "Title'` or `/ Hardware`. */
function stripQuotesAndPunctuation(raw: string): string {
  return raw
    .replace(/^[\s"“”'',./\-–—]+/, "")    // leading quote/punct/whitespace
    .replace(/[\s"“”'',.;:]+$/, "")       // trailing same
    .trim()
}

/** Body-item / article-heading patterns that masquerade as titles when the
 *  parser hits a page-header line and looks ahead for the next non-blank
 *  line. NEVER keep a title matching one of these. */
const BODY_FRAGMENT_PATTERNS: RegExp[] = [
  /^PART\s+\d/i,            // "PART 3 - EXECUTION"
  /^\d+\.\d+(?:\.\d+)?\s/,  // "3.2 PREPARATION", "1.1 SUMMARY"
  /^\d+\.\s/,               // "1. SSPC-Sp 2.", "10. Acoustical Performance"
  /^[A-Z]\.\s/,             // "B. Fire-Retardant…", "A. Section Includes"
]

function isBodyFragment(title: string): boolean {
  return BODY_FRAGMENT_PATTERNS.some(re => re.test(title))
}

function letterCount(s: string): number {
  return s.replace(/[^A-Za-z]/g, "").length
}

// ─── Title-shape gate (Layer 1d) ─────────────────────────────────────────────
//
// A real section title is a noun phrase in Title-Case or ALL-CAPS. An inline
// cross-reference dropped to column 0 by pdf.js line-wrapping yields a SENTENCE
// fragment as the "title" — e.g. "to produce weathertight installation",
// "at the sole cost of the Contractor. Such activities are". These are rejected
// by shape:
//   - must not begin with a lowercase letter (prose continuation)
//   - must not contain a mid-string sentence/abbreviation period ". "
//     ("Contractor. Such…", "(Project No. …")
//   - must not end with a dangling comma
// Minor words after commas ("Testing, Adjusting, and Balancing for HVAC") are
// deliberately NOT rejected — only the prose signatures above. This gate is
// about document STRUCTURE, not any one book's house style.
function passesTitleShape(title: string): boolean {
  const fa = title.match(/[A-Za-z]/)
  if (fa && fa[0] === fa[0].toLowerCase() && fa[0] !== fa[0].toUpperCase()) return false
  if (/\.\s/.test(title)) return false       // mid-title sentence / "No." period
  if (/,\s*$/.test(title)) return false       // dangling trailing comma
  return true
}

/** Validate + normalize a raw title string. Returns the cleaned title
 *  when it passes (≥ 3 letters, not a body fragment, clean shape), else null. */
function validateTitle(raw: string): string | null {
  if (!raw) return null
  const stripped = stripQuotesAndPunctuation(raw)
  const cleaned = cleanTitle(stripped)
  if (letterCount(cleaned) < 3) return null
  if (isBodyFragment(cleaned)) return null
  if (!passesTitleShape(cleaned)) return null
  return cleaned
}

// Strict tier-0 header: line LITERALLY starts with `SECTION`, has the
// section number, then a dash/colon separator, then a non-empty title on
// the SAME LINE. The strict separator (not comma, not quote) rejects
// cross-references in body prose like:
//   `Section 071605, "Water Vapor Emission Control System - Station Building"`
//   `as specified in Section 071605 "Title"`
// while still matching the real header
//   `SECTION 071605 – WATER VAPOR EMISSION CONTROL SYSTEM - STATION BUILDING`.
const STRICT_HEADER_LINE =
  /^\s*SECTION\s+(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?\s*[-–—:]\s*(.+)$/i

// Loose fallback: bare number (with or without SECTION prefix). The trailing
// `(?!\d)` is the Layer-1a digit-run anchor — it forbids a 6-digit CSI window
// that is actually part of a longer digit run. Without it the Yale project
// number `10102202` reads as section `10 10 22`.
const SAME_LINE_HEADER =
  /^\s*(?:SECTION\s+)?(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?(?!\d)\s*(?:[-–—:]\s*)?(.*)$/i

// ─── Structural signals (Layer 1) ────────────────────────────────────────────
//
// Digit-anchored CSI number ANYWHERE on a line (not just column 0). Same
// `(?<!\d) … (?!\d)` guard as above so embedded runs (project / consultant job
// numbers) are rejected.
const CSI_NUMBER_ANYWHERE =
  /(?<!\d)(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?(?!\d)/g

// The CSI 3-part-format body always opens with PART 1 (GENERAL). Its presence
// in a page's top block is the generic structural signal that the page is a
// section START — independent of any one book's header styling. This is what
// recovers sections whose number appears ONLY in the running header
// (number-at-end), which the `^`-anchored line matchers never see.
//
// The optional leading `P` tolerates a real pdf.js wart: a kerned/drop-cap
// first glyph is sometimes dropped from the text layer, so "PART 1 - GENERAL"
// extracts as "ART 1 - GENERAL". The trailing `1\b` keeps this from matching
// "ARTICLE"/"PARTITION".
const PART1_MARKER = /^\s*P?ART\s*1\b/i

// Running-header / footer band — never carries the section title.
const RUNNING_HEADER_LINE = /\bProject\s+No\.?|\bPage\s+\d/i

// Prose-continuation tails (Layer 1c): when the line immediately before a
// bare-number candidate ends with one of these, the number is an inline
// cross-reference ("…as defined in Section⏎014000 …"), not a header.
const CONTINUATION_TAIL =
  /(?:\b(?:section|sections|division|divisions|no|and|or|in|on|with|per|of|to|for|as|by|the|a|an|at|from|within|under|specified)\b[.,:;]?|[,(])\s*$/i

const HEADER_BLOCK_LINES = 12   // top-of-page window scanned for number + PART 1
const TOP_BLOCK_LINES    = 8    // a bare-number candidate this high on the page
                                //  counts as structurally "top of page"
const PART1_LOOKAHEAD    = 10   // …or PART 1 within this many following lines

function prevNonEmpty(lines: string[], i: number): string | null {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim()
    if (t.length > 0) return t
  }
  return null
}

/** Strip a leading "NNNNNN –" / "SECTION NNNNNN -" / "DOCUMENT NNNNNN -"
 *  prefix off a title line. */
function stripSectionNumberPrefix(line: string): string {
  const m = line.match(/^\s*(?:(?:SECTION|DOCUMENT)\s+)?\d{2}\s?\d{2}\s?\d{2}(?:\.\d{1,2})?\s*[-–—:]?\s*(.*)$/i)
  return m ? m[1] : line
}

/** The section number for a header-block page. Prefers the running-header line
 *  (it contains the keyword "Section") so consultant job numbers on adjacent
 *  lines ("Buro Happold Project No. 053902") are not mistaken for sections. */
function findHeaderBlockNumber(lines: string[], blockEnd: number): string | null {
  for (const preferSection of [true, false]) {
    for (let j = 0; j < blockEnd; j++) {
      const line = lines[j]
      if (preferSection && !/\bsection\b/i.test(line)) continue
      if (!preferSection && /\bProject\s+No\.?/i.test(line)) continue
      CSI_NUMBER_ANYWHERE.lastIndex = 0
      let mm: RegExpExecArray | null
      while ((mm = CSI_NUMBER_ANYWHERE.exec(line)) !== null) {
        if (!VALID_DIVISIONS.has(mm[1])) continue
        const n = `${mm[1]} ${mm[2]} ${mm[3]}`
        if (n !== "00 00 00") return n
      }
    }
  }
  return null
}

/** The section title in a header block, ANCHORED to this section's on-page
 *  header line. Firms write the header three ways, all handled structurally
 *  (no house-style vocabulary):
 *    1. keyword + inline title  — "SECTION 14 24 00 – Hydraulic Elevators"
 *    2. keyword, title below    — "SECTION 03 01 31" ⏎ "CONCRETE PATCHING"
 *                                  (incl. wrapped: ⏎ "GLASS FIBER REINFORCED"
 *                                   ⏎ "CONCRETE")
 *    3. bare number + inline    — "230523 – Piping, Valves, and Fittings" (KPMB)
 *  The header line is found by the section number AT LINE START. This excludes
 *  the page's running banner (firm/owner, address "New Haven, CT", date) which
 *  carries no leading number, AND — crucially — the running-FOOTER band, which
 *  is either number-at-end ("…CONCRETE PATCHING 03 01 31-1") or number-at-start
 *  with only a page number after it ("282301 - 1"): the latter is told apart
 *  from a real bare header by requiring a VALID inline title (a page number
 *  fails `validateTitle`).
 *
 *  When no such header line exists (number only in the running header/footer,
 *  title printed as a bare banner line), there is nothing to anchor to: it
 *  falls back to the legacy top-block scan and reports `anchored: false`, so
 *  the caller hands this lower-confidence guess to review. */
function findHeaderBlockTitle(
  lines: string[],
  blockEnd: number,
  num: string,
): { title: string; anchored: boolean } {
  const [d1, d2, d3] = num.split(" ")
  // This section's number at line start, optionally behind a SECTION/DOCUMENT
  // keyword, with the rest of the line captured as a possible inline title.
  // m[1] = keyword (or undefined), m[2] = inline remainder.
  const headerRe = new RegExp(
    `^\\s*(SECTION\\s+|DOCUMENT\\s+)?${d1}\\s?${d2}\\s?${d3}(?:\\.\\d{1,2})?(?!\\d)\\s*(?:[-–—:]\\s*)?(.*)$`, "i",
  )
  let keywordAnchor = -1
  for (let j = 0; j < blockEnd; j++) {
    const m = lines[j].match(headerRe)
    if (!m) continue
    const inline = validateTitle(m[2] ?? "")
    if (inline) return { title: inline, anchored: true }   // form 1 or 3 — inline title
    // No inline title. A keyword header anchors the title on the line(s) below
    // (form 2); a bare "NNNNNN - 1" footer band does NOT (skip it, keep scanning).
    if (m[1] && keywordAnchor === -1) keywordAnchor = j
  }

  if (keywordAnchor !== -1) {
    // Join a (possibly wrapped) title from the line(s) below the keyword header.
    // Each continuation must itself be title-shaped (Title-Case/ALL-CAPS, short,
    // no sentence punctuation, no mid-line CSI number) so body prose is never
    // glued on; the scan stops at PART 1 / a numbered article / the running
    // header / a blank line.
    const parts: string[] = []
    for (let j = keywordAnchor + 1; j < blockEnd && parts.length < 3; j++) {
      const line = lines[j].trim()
      if (!line) { if (parts.length) break; continue }
      if (PART1_MARKER.test(line)) break
      if (RUNNING_HEADER_LINE.test(line)) { if (parts.length) break; continue }
      if (isBodyFragment(line)) break
      if (!passesTitleShape(line) || letterCount(line) < 1 || line.length > 60) break
      const startsWithNum = /^\s*(?:SECTION\s+)?\d{2}\s?\d{2}\s?\d{2}/i.test(line)
      CSI_NUMBER_ANYWHERE.lastIndex = 0
      if (!startsWithNum && CSI_NUMBER_ANYWHERE.test(line)) break
      // Stop if this line just repeats the title (some firms echo the title on
      // the next line, sometimes with a trailing date) — don't double it up.
      const lower = line.toLowerCase()
      if (parts.some(p => { const a = p.toLowerCase(); return a === lower || lower.startsWith(a) || a.startsWith(lower) })) break
      parts.push(line)
    }
    const joined = validateTitle(parts.join(" "))
    if (joined) return { title: joined, anchored: true }
    // Keyword header but no usable title below — fall through to the legacy scan.
  }

  // No header line to anchor to — legacy top-block scan (lower confidence). A
  // real title line either STARTS with the section number ("Section 018119
  // Construction IAQ Requirements", "230000 – General Provisions") or carries
  // no number at all ("Summary", "Storm Sewer Systems"). Any line with a CSI
  // number that is NOT at the start is the page banner or a cross-reference —
  // skip it.
  for (let j = 0; j < blockEnd; j++) {
    const line = lines[j].trim()
    if (!line) continue
    if (PART1_MARKER.test(line)) break
    if (RUNNING_HEADER_LINE.test(line)) continue
    const startsWithNum = /^\s*(?:SECTION\s+)?\d{2}\s?\d{2}\s?\d{2}/i.test(line)
    CSI_NUMBER_ANYWHERE.lastIndex = 0
    if (!startsWithNum && CSI_NUMBER_ANYWHERE.test(line)) continue
    if (isBodyFragment(line)) continue
    const t = validateTitle(stripSectionNumberPrefix(line))
    if (t) return { title: t, anchored: false }
  }
  return { title: "", anchored: false }
}

/** The section number carried in a page's running header (top 3 lines): a
 *  digit-anchored CSI number on a line that names "Section". Returns null when
 *  the page has no running-header number (covers, dividers). Used by the
 *  running-header-delta detector to recover sections with NO body text layer
 *  (scanned/image pages), whose only on-page signal is the header number. */
function extractRunningHeaderNumber(pageText: string): string | null {
  const lines = pageText.split("\n")
  for (let j = 0; j < Math.min(lines.length, 3); j++) {
    if (!/\bsection\b/i.test(lines[j])) continue
    CSI_NUMBER_ANYWHERE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = CSI_NUMBER_ANYWHERE.exec(lines[j])) !== null) {
      if (!VALID_DIVISIONS.has(mm[1])) continue
      const n = `${mm[1]} ${mm[2]} ${mm[3]}`
      if (n !== "00 00 00") return n
    }
  }
  return null
}

/**
 * Find section-start candidates on one page.
 *
 *  - `gated: false` (TOC mode) — legacy loose behavior: tier-0 strict + any
 *    bare "NN NN NN Title" line. The TOC lists every section as exactly such a
 *    line, and detectTocRegion counts these to locate the TOC. Never apply the
 *    structural body gate here or the TOC vanishes.
 *  - `gated: true` (body mode) — tier-0 strict (unchanged) + the structural
 *    header-block detector + the bare-number loose path behind all four Layer-1
 *    gates. This is the actual fix.
 */
function findCandidatesInPage(
  pageText: string,
  page: number,
  pageStartOffset: number,
  opts: { gated: boolean } = { gated: false },
): Candidate[] {
  const out: Candidate[] = []
  const lines = pageText.split("\n")

  // ── Structural header-block detector (body mode only) ────────────────────
  // A page is a section START when its top block carries a CSI number AND a
  // PART 1 marker. Emits at the page top so the running header is included.
  if (opts.gated) {
    const blockEnd = Math.min(lines.length, HEADER_BLOCK_LINES)
    let hasPart1 = false
    for (let j = 0; j < blockEnd; j++) if (PART1_MARKER.test(lines[j])) { hasPart1 = true; break }
    if (hasPart1) {
      const num = findHeaderBlockNumber(lines, blockEnd)
      if (num) {
        const { title, anchored } = findHeaderBlockTitle(lines, blockEnd, num)
        out.push({
          specNumber: num,
          specTitle: title,
          // Anchored to the on-page SECTION line → trusted "header-block".
          // An un-anchored top-block scrape → "header-scan" (ranks below a
          // clean lookahead, handed to review). No title → anchor only.
          tier: title ? (anchored ? "header-block" : "header-scan") : "no-clean-title",
          page,
          globalOffset: pageStartOffset,   // section starts at the top of this page
        })
      }
    }
  }

  // ── Line-start matching (tier-0 always; loose path gated in body mode) ───
  let offsetInPage = 0
  for (let i = 0; i < lines.length; i++) {
    const lineOffset = offsetInPage
    offsetInPage += lines[i].length + 1

    // Tier 0 — strict SECTION header. Always trusted, never gated.
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

    // Loose bare-number match. In TOC mode this runs unconditionally (legacy).
    // In body mode it must clear Layer 1: (a) digit-anchor is baked into the
    // regex, (b) structural position, (c) preceding-context, (d) title-shape.
    const m = lines[i].match(SAME_LINE_HEADER)
    if (!m) continue
    const div = m[1]
    if (!VALID_DIVISIONS.has(div)) continue
    const specNumber = `${m[1]} ${m[2]} ${m[3]}`
    if (specNumber === "00 00 00") continue

    if (opts.gated) {
      const topOfPage = i < TOP_BLOCK_LINES
      let part1Follows = false
      for (let j = i + 1; j < Math.min(lines.length, i + 1 + PART1_LOOKAHEAD); j++) {
        if (PART1_MARKER.test(lines[j])) { part1Follows = true; break }
      }
      if (!topOfPage && !part1Follows) continue            // (b) structural signal
      const prev = prevNonEmpty(lines, i)
      if (prev && CONTINUATION_TAIL.test(prev)) continue   // (c) preceding-context
    }

    const sameLineValid = validateTitle(m[4] ?? "")        // (d) title-shape

    let title = ""
    let tier: TitleTier
    if (sameLineValid !== null) {
      title = sameLineValid
      tier  = "bare-same-line"
    } else {
      // Lookahead — only inspect the FIRST non-blank following line.
      let lookaheadTitle: string | null = null
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const next = lines[j].trim()
        if (letterCount(next) < 3) continue
        lookaheadTitle = validateTitle(next)
        break
      }
      if (lookaheadTitle !== null) {
        title = lookaheadTitle
        tier  = "lookahead"
      } else {
        title = ""
        tier  = "no-clean-title"
      }
    }

    out.push({ specNumber, specTitle: title, tier, page, globalOffset: pageStartOffset + lineOffset })
  }
  return out
}

const TIER_RANK: Record<TitleTier, number> = {
  "section-prefix":   0,
  "header-block":     1,   // anchored to the SECTION/DOCUMENT header — trusted
  "bare-same-line":   2,
  "header-scan":      3,   // un-anchored top-block scrape: beats a (possibly
                           //   footer-band-induced, garbage) lookahead, but loses
                           //   to an anchored header; always flagged for review
  "lookahead":        4,
  "running-header":   5,
  "no-clean-title":   6,
}

/**
 * Pick the real section header among duplicate occurrences of the same
 * spec number. Two-stage:
 *
 *   1. **Tier first.** A line that literally says `SECTION NNNNNN —
 *      <clean title>` beats a bare page-header (`NNNNNN - 4`) every time,
 *      regardless of how much body text sits after each. This is what
 *      the prior gap-only heuristic missed: a spec book that repeats
 *      `NNNNNN - <pgnum>` as a page header on every body page produces
 *      many low-tier candidates whose gaps to the NEXT section can be
 *      large; the genuine section header (early in the section) has a
 *      smaller gap because the next page-header follows quickly.
 *
 *   2. **Gap within the chosen tier.** Among candidates of the best
 *      available tier, the largest-gap one wins — same idea as the
 *      original heuristic, but now scoped to candidates we already
 *      trust by structure.
 */
function dedupeByTierThenGap(all: Candidate[], totalChars: number): Candidate[] {
  const ordered = [...all].sort((a, b) => a.globalOffset - b.globalOffset)

  // Compute each candidate's gap to the NEXT candidate in document order
  // (irrespective of spec number). Same coordinate as the prior heuristic.
  const gaps = new Array<number>(ordered.length)
  for (let i = 0; i < ordered.length; i++) {
    gaps[i] = (i + 1 < ordered.length ? ordered[i + 1].globalOffset : totalChars) - ordered[i].globalOffset
  }

  // Group by specNumber; within each group, pick the best-tier candidate
  // and within that the largest gap.
  const grouped = new Map<string, Array<{ cand: Candidate; gap: number; idx: number }>>()
  for (let i = 0; i < ordered.length; i++) {
    const arr = grouped.get(ordered[i].specNumber) ?? []
    arr.push({ cand: ordered[i], gap: gaps[i], idx: i })
    grouped.set(ordered[i].specNumber, arr)
  }

  const picked: Candidate[] = []
  for (const arr of grouped.values()) {
    let bestTier = Infinity
    for (const e of arr) bestTier = Math.min(bestTier, TIER_RANK[e.cand.tier])
    const inBestTier = arr.filter(e => TIER_RANK[e.cand.tier] === bestTier)
    let bestEntry = inBestTier[0]
    for (const e of inBestTier) if (e.gap > bestEntry.gap) bestEntry = e
    picked.push(bestEntry.cand)
  }

  return picked.sort((a, b) => a.globalOffset - b.globalOffset)
}

// ─── Layer 2 — footer-title fallback ────────────────────────────────────────
//
// Spec books following the THP / BAM template print the section title at
// the bottom of every body page in this exact shape:
//
//     [body text, possibly with the page-number stuck on]
//     <TITLE-IN-CAPS-or-Title-Case>     ← standalone line
//     Project No. NNNN-NNNN              ← required anchor
//
// The trailing "Project No." marker is what makes this pattern safe to
// trust — it almost never appears in body content of other formats, and
// when it doesn't appear at all (non-THP books) the fallback returns null
// and we move on to last-resort.
//
// Required strict shape to avoid false-firing on books that don't use this
// template: the title line MUST be all-caps OR Title-Case, MUST be on a
// line by itself (preceded + followed by newlines), and MUST be immediately
// followed by a "Project No." line.
const FOOTER_TITLE_RE =
  /\n\s*([A-Z][A-Z\s\-/&,]{4,80}|[A-Z][A-Za-z][A-Za-z\s\-/&,]{4,80})\s*\n\s*Project\s+No\.?/

function extractFooterTitle(fullText: string): string | null {
  if (!fullText) return null
  // Search globally; take the FIRST hit — the section title repeats every
  // body page, so the first occurrence is fine.
  const m = fullText.match(FOOTER_TITLE_RE)
  if (!m) return null
  const candidate = cleanTitle(stripQuotesAndPunctuation(m[1]))
  if (letterCount(candidate) < 3) return null
  if (isBodyFragment(candidate)) return null
  return candidate
}

// ─── SUBMITTALS article extraction ───────────────────────────────────────────

// An article heading: a numbered sub-clause like "1.4 SUBMITTALS" or
// "1.3 Action Submittals". Used both to locate SUBMITTALS articles and to know
// where the next (non-submittal) article begins. The title may be ALL-CAPS
// (engineering/structural sections) OR Title-Case (the KPMB architectural
// template uses "Action Submittals", "Informational Submittals", "Closeout
// Submittals", "Summary", …) — so the title is mixed-case, but its FIRST
// character must still be a capital letter. That capital-first requirement is
// what keeps line-leading measurements ("0.5 inches") from registering as
// article headings.
const ARTICLE_HEADING = /(?:^|\n)[ \t]*(\d{1,2}\.\d{1,2})[ \t]+([A-Z][A-Za-z0-9 ,/&'’.\-]{2,60})/g

// Hard boundaries that end a SUBMITTALS article even when no numbered article
// heading follows it (e.g. SUBMITTALS is the last article in PART 1): the next
// PART, or the section terminator. Without this the extracted text runs to the
// end of the section and sweeps in PART 2/3 product and execution language.
const PART_OR_END = /(?:^|\n)[ \t]*(?:PART[ \t]+\d|END[ \t]+OF[ \t]+SECTION)\b/gi

/** First PART/END-OF-SECTION boundary at or after `from`, else text length. */
function firstHardStopAfter(text: string, from: number): number {
  PART_OR_END.lastIndex = Math.max(0, from)
  const m = PART_OR_END.exec(text)
  return m ? m.index : text.length
}

// PART-1 article titles that carry chase-able submittal deliverables. The
// SUBMITTALS article is the obvious one, but real spec sections scatter real
// submittal items across sibling articles that a SUBMITTAL-only filter silently
// dropped:
//   QUALITY ASSURANCE      — mfr/installer qualification statements, mockups, certs
//   WARRANTY / GUARANTEES AND WARRANTIES — each individually-termed warranty
//   MAINTENANCE MATERIAL SUBMITTALS      — attic stock / spare materials
//   DELEGATED DESIGN       — signed/sealed delegated-design data to submit
//   CLOSEOUT SUBMITTALS    — already covered by "SUBMITTAL"
// Match is SUBSTRING, case-insensitive, against the whitespace-normalized title
// — NOT exact equality: "GUARANTEES AND WARRANTIES" and "MAINTENANCE MATERIAL
// SUBMITTALS" both occur in real books and exact-match would miss them. So
// "WARRANT" catches WARRANTY/WARRANTIES and "GUARANTEE" catches GUARANTEE(S).
// This whitelist was validated against ALL 107 sections of the Long Lots spec
// book (full scan). "CT HIGH PERFORMANCE BUILDING STANDARD REQUIREMENTS" is
// deliberately excluded to match the Procore benchmark.
const SUBMITTAL_ARTICLE_KEYWORDS = [
  "SUBMITTAL", "WARRANT", "GUARANTEE", "QUALITY ASSURANCE", "MAINTENANCE", "DELEGATED DESIGN",
] as const

/** True when an article title names an article that carries submittal items. */
function isSubmittalBearingArticle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").toUpperCase()
  return SUBMITTAL_ARTICLE_KEYWORDS.some(k => t.includes(k))
}

// A table-of-contents dotted-leader entry ("Waste Management Plan ....... 5").
// Some spec sections open with a section-internal TOC whose lines survive into
// the extracted article blocks (the O&G/Perini Amtrak 13 30 50 opens with
// several) — they are index entries, not requirements. Stripped per block.
const TOC_LEADER_LINE = /\.{5,}\s*\d+\s*$/

/**
 * Extracts every submittal-bearing PART-1 article from a section's text, ONE
 * STRING PER ARTICLE. This is the SUBMITTALS article (SUBMITTALS, ACTION /
 * INFORMATIONAL / CLOSEOUT SUBMITTALS) PLUS the sibling articles that carry
 * real submittal items — QUALITY ASSURANCE, WARRANTY / GUARANTEES AND
 * WARRANTIES, MAINTENANCE MATERIAL SUBMITTALS, DELEGATED DESIGN (see
 * SUBMITTAL_ARTICLE_KEYWORDS). Articles are located by TITLE, not by number
 * (SUBMITTALS sits at 1.3 in some sections, 1.4 in others). Each article runs
 * until the FIRST of: the next article heading, the next PART heading, or END
 * OF SECTION — so it never reads past its natural end.
 *
 * The per-article grain exists so the classifier can send ONE Haiku call per
 * article instead of the whole concatenation — the itemization of a long
 * section overflows a single response otherwise. extractSubmittalsText below
 * is exactly this array joined, so the two can never drift.
 */
export function extractSubmittalArticles(sectionText: string): string[] {
  const headings: { index: number; title: string }[] = []
  ARTICLE_HEADING.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ARTICLE_HEADING.exec(sectionText)) !== null) {
    headings.push({ index: m.index, title: m[2].trim() })
  }

  const blocks: string[] = []
  for (let i = 0; i < headings.length; i++) {
    if (!isSubmittalBearingArticle(headings[i].title)) continue
    const start = headings[i].index
    const nextArticle = i + 1 < headings.length ? headings[i + 1].index : sectionText.length
    const hardStop = firstHardStopAfter(sectionText, start + 1)
    const block = sectionText
      .slice(start, Math.min(nextArticle, hardStop))
      .split("\n")
      .filter(line => !TOC_LEADER_LINE.test(line))
      .join("\n")
      .trim()
    if (block) blocks.push(block)
  }
  return blocks
}

/** The submittal-bearing articles as one concatenated string — the value
 *  persisted to spec_sections.submittals_text. Returns "" when none present. */
export function extractSubmittalsText(sectionText: string): string {
  return extractSubmittalArticles(sectionText).join("\n\n")
}

// ─── Top-level parse ─────────────────────────────────────────────────────────

export async function parseSpecBook(buffer: Buffer): Promise<SpecParseResult> {
  const pages = await extractPdfPages(buffer)
  const pageCount = pages.length

  // Cumulative char offset where each page begins, for global ordering.
  const pageStartOffsets: number[] = []
  let acc = 0
  for (const p of pages) {
    pageStartOffsets.push(acc)
    acc += p.length + 1
  }
  const totalChars = acc

  if (pageCount > 0 && totalChars / pageCount < 100) {
    return { pageCount, totalChars, needsOcr: true, sections: [] }
  }

  // TOC region is detected from UNGATED candidates: the TOC lists every section
  // as a bare "NN NN NN Title …" line — exactly what the structural body gate
  // suppresses — so its density is only visible without the gate. A multi-
  // volume spec book lists every section in its TOC but carries the bodies for
  // only some divisions; excluding the region keeps TOC-only sections from
  // collapsing onto the TOC page as junk "sections".
  const ungatedPerPage = pages.map((p, i) => findCandidatesInPage(p, i + 1, pageStartOffsets[i], { gated: false }))
  const tocRegion = detectTocRegion(ungatedPerPage, pageCount)

  // Body detection uses the gated structural detector (tier-0 + header-block +
  // gated-loose). This is the Layer-1 fix.
  const gatedPerPage = pages.map((p, i) => findCandidatesInPage(p, i + 1, pageStartOffsets[i], { gated: true }))

  const candidates: Candidate[] = []
  for (let i = 0; i < gatedPerPage.length; i++) {
    if (tocRegion && i >= tocRegion.start && i <= tocRegion.end) continue
    candidates.push(...gatedPerPage[i])
  }

  // Running-header-delta — recover sections that have NO body text layer
  // (scanned/image pages, e.g. a section printed as flat images). Their only
  // on-page signal is the running-header number changing from the previous
  // page. Emitted ONLY for numbers no content detector already found, so this
  // never perturbs existing detection; it only ADDS otherwise-invisible
  // sections, flagged for review downstream.
  const detectedNums = new Set(candidates.map(c => c.specNumber))
  const addedRunning = new Set<string>()
  let prevNum: string | null = null
  for (let i = 0; i < pages.length; i++) {
    if (tocRegion && i >= tocRegion.start && i <= tocRegion.end) { prevNum = null; continue }
    const num = extractRunningHeaderNumber(pages[i])
    if (num && num !== prevNum && !detectedNums.has(num) && !addedRunning.has(num)) {
      candidates.push({ specNumber: num, specTitle: "", tier: "running-header", page: i + 1, globalOffset: pageStartOffsets[i] })
      addedRunning.add(num)
    }
    if (num) prevNum = num
  }

  const headers = dedupeByTierThenGap(candidates, totalChars)

  // Whole-document text in the same coordinate space as Candidate.globalOffset
  // (pageStartOffsets advance by page length + 1, matching a "\n" join).
  const docText = pages.join("\n")

  const sections: ParsedSection[] = headers.map((h, i) => {
    const startPage = h.page
    const endPage =
      i + 1 < headers.length ? Math.max(startPage, headers[i + 1].page - 1) : pageCount
    // Slice by global char offset rather than whole pages: when the next
    // section starts mid-page that page belongs to both, and page-slicing
    // bleeds the next section's body into this one (and the previous
    // section's tail onto the top of this one). Offsets hard-stop the text
    // exactly at each section header.
    const startOff = h.globalOffset
    const endOff = i + 1 < headers.length ? headers[i + 1].globalOffset : docText.length
    const fullText = docText.slice(startOff, endOff)

    // Title resolution — Layer 1 result first; fall back to Layer 2 if
    // Layer 1 left it empty (the "no-clean-title" tier); fall back finally
    // to MasterFormat division name + needsTitleReview flag.
    let specTitle = h.specTitle
    let titleSource: ParsedSection["titleSource"] =
      h.tier === "section-prefix" ? "section-prefix" :
      h.tier === "header-block"   ? "header-block" :
      h.tier === "header-scan"    ? "header-block" :  // un-anchored variant of the same source
      h.tier === "bare-same-line" ? "bare-same-line" :
      h.tier === "lookahead"      ? "lookahead" :
      "masterformat-fallback"  // placeholder — overwritten below if Layer 2 hits
    // A running-header-delta boundary has no readable body, and a header-scan
    // title is an un-anchored top-block guess: flag both for review. (A later
    // TOC join can clear a header-scan flag when it supplies a canonical title;
    // the scanned-page density check below re-flags the running-header case.)
    let needsTitleReview = h.tier === "running-header" || h.tier === "header-scan"

    if (h.tier === "no-clean-title" || h.tier === "running-header" || specTitle === "") {
      const footerTitle = extractFooterTitle(fullText)
      if (footerTitle !== null) {
        specTitle = footerTitle
        titleSource = "footer-pattern"
      } else {
        // Last resort: MasterFormat division name. NEVER a body fragment.
        specTitle = divisionNameFor(h.specNumber)
        titleSource = "masterformat-fallback"
        needsTitleReview = true
      }
    }

    // Smart Title Case the final title. Acronyms preserved (HVAC, EPDM,
    // CMU…), hyphens handled (Cast-in-Place not Cast-In-Place), minor
    // words lowercased except when first. Skipped only for last-resort
    // MasterFormat fallbacks (already title-case from the DIVISION_NAMES
    // dict, no need to re-process).
    if (titleSource !== "masterformat-fallback") {
      specTitle = smartTitleCase(specTitle)
    }

    return {
      specNumber: h.specNumber,
      specTitle,
      startPage,
      endPage,
      fullText,
      submittalsText: extractSubmittalsText(fullText),
      needsTitleReview,
      titleSource,
    }
  })

  // ── Layer 2 — TOC validation + title enrichment (ADR-005) ────────────────
  // Safety-net ONLY. The invariant inside applyTocJoin forbids it from adding,
  // moving, removing, or re-paging any boundary.
  applyTocJoin(sections, pages)

  // Flag likely-scanned sections (almost no extractable text per page) for
  // review even when a clean TOC title was joined on — their body could not be
  // parsed and submittals cannot be extracted from them.
  for (const s of sections) {
    const pp = Math.max(1, s.endPage - s.startPage + 1)
    if (s.fullText.length / pp < 200) s.needsTitleReview = true
  }

  return { pageCount, totalChars, needsOcr: false, sections }
}

// Truncated-title signature: a real header title never ends on a dangling
// conjunction/preposition. Used to decide a body title is worth replacing with
// the canonical TOC title.
const DANGLING_TAIL = /\b(?:and|or|the|to|for|of|with|a|an|in|on|at|by|per|as|from)\s*$/i

/**
 * Layer 2 — join detected boundaries against the book's own table of contents.
 *
 *   VALIDATE : a boundary whose spec number is absent from the TOC is flagged
 *              (notInToc + needsTitleReview). It is NEVER dropped.
 *   ENRICH   : a boundary whose number IS in the TOC but whose detected title
 *              is weak/fragment/truncated is relabelled with the canonical TOC
 *              title.
 *
 * HARD INVARIANT (ADR-005), enforced at runtime below, not merely documented:
 * this function may mutate ONLY specTitle / titleSource / needsTitleReview /
 * notInToc on existing sections. It must never create, remove, move, or re-page
 * a boundary. count(TOC) must NOT become count(boundaries).
 */
function applyTocJoin(sections: ParsedSection[], pages: string[]): void {
  const beforeCount = sections.length
  const beforeShape = sections.map(s => `${s.specNumber}@${s.startPage}-${s.endPage}`).join("|")

  const tocEntries = extractSpecToc(pages)
  const tocTitle = new Map<string, string>()
  for (const e of tocEntries) if (e.specTitle) tocTitle.set(e.specNumber, e.specTitle)
  const tocNumbers = new Set(tocEntries.map(e => e.specNumber))

  for (const s of sections) {
    if (!tocNumbers.has(s.specNumber)) {
      // VALIDATE — number not in the TOC: suspect boundary, flag for review.
      s.notInToc = true
      s.needsTitleReview = true
      continue
    }
    const canonical = tocTitle.get(s.specNumber)
    if (!canonical) continue
    const weak =
      s.needsTitleReview ||
      s.titleSource === "masterformat-fallback" ||
      s.titleSource === "footer-pattern" ||
      !passesTitleShape(s.specTitle) ||
      DANGLING_TAIL.test(s.specTitle)
    // Only ENRICH when the canonical TOC title is itself clean — never replace a
    // body title with a TOC entry that is truncated/dangling (some TOCs clip
    // long titles, e.g. "…Subgrade Preparation for"). A dangling canonical can
    // still flag the section for review (above) but must not become the title.
    if (weak && passesTitleShape(canonical) && letterCount(canonical) >= 3 && !DANGLING_TAIL.test(canonical)) {
      // ENRICH — replace the weak title with the canonical TOC title.
      s.specTitle = smartTitleCase(canonical)
      s.titleSource = "toc-enriched"
      s.needsTitleReview = false
    }
  }

  // Invariant enforcement (code-level): boundaries are untouched by the join.
  const afterShape = sections.map(s => `${s.specNumber}@${s.startPage}-${s.endPage}`).join("|")
  if (sections.length !== beforeCount || afterShape !== beforeShape) {
    throw new Error(
      `Layer 2 TOC join violated the no-boundary-change invariant ` +
      `(${beforeCount} -> ${sections.length} sections). The TOC may enrich ` +
      `titles only; it must never create or move a boundary.`,
    )
  }
}

// ─── Table-of-contents parsing (project scope) ───────────────────────────────

const TOC_DENSITY_THRESHOLD = 4  // min section-number lines per page to count as TOC
const TOC_SEARCH_FRACTION   = 0.3 // only look for the TOC in the first 30% of the doc

/**
 * Locates the table-of-contents region: the densest run of section-number lines
 * within the front of the document. A TOC packs many section numbers onto a few
 * pages; body pages have ~1 (the section header) or none. Returns 0-based
 * inclusive page indices, or null when there is no clear TOC.
 *
 * Shared by extractSpecToc (which reads the region) and parseSpecBook (which
 * excludes it, so TOC-only sections are not mistaken for real ones).
 */
function detectTocRegion(
  perPage: Candidate[][],
  pageCount: number,
): { start: number; end: number } | null {
  const searchLimit = Math.min(pageCount, Math.max(1, Math.ceil(pageCount * TOC_SEARCH_FRACTION)))

  let bestStart = -1, bestEnd = -1, bestCount = 0
  let runStart = -1, runCount = 0
  const closeRun = (endExclusive: number) => {
    if (runStart !== -1 && runCount > bestCount) {
      bestStart = runStart
      bestEnd = endExclusive - 1
      bestCount = runCount
    }
    runStart = -1
    runCount = 0
  }
  for (let i = 0; i < searchLimit; i++) {
    if (perPage[i].length >= TOC_DENSITY_THRESHOLD) {
      if (runStart === -1) runStart = i
      runCount += perPage[i].length
    } else {
      closeRun(i)
    }
  }
  closeRun(searchLimit)

  return bestStart !== -1 ? { start: bestStart, end: bestEnd } : null
}

/**
 * Extracts the flat list of spec sections from a spec book's table of contents.
 * If no dense TOC run exists (book has no TOC), every section-number line in the
 * document is used, deduped to the first occurrence of each number.
 *
 * This is the inverse of parseSpecBook's body-length dedupe, which discards the
 * dense TOC cluster — different goal, hence a separate function.
 */
export function extractSpecToc(pages: string[]): TocEntry[] {
  const perPage = pages.map((p, i) => findCandidatesInPage(p, i + 1, 0))
  const toc = detectTocRegion(perPage, pages.length)

  const collected = toc
    ? perPage.slice(toc.start, toc.end + 1).flat()
    : perPage.flat()

  const seen = new Set<string>()
  const entries: TocEntry[] = []
  for (const c of collected) {
    if (seen.has(c.specNumber)) continue
    seen.add(c.specNumber)
    entries.push({
      specNumber: c.specNumber,
      specTitle: c.specTitle,
      divisionCode: c.specNumber.slice(0, 2),
    })
  }
  entries.sort((a, b) => a.specNumber.localeCompare(b.specNumber))
  return entries
}

/** Rolls a TOC section list up into the divisions present, with section counts. */
export function divisionsFromToc(entries: TocEntry[]): TocDivision[] {
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e.divisionCode, (counts.get(e.divisionCode) ?? 0) + 1)
  return [...counts.entries()]
    .map(([code, sectionCount]) => ({
      code,
      name: DIVISION_NAMES[code] ?? `Division ${code}`,
      sectionCount,
    }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

export interface TocParseResult {
  pageCount: number
  needsOcr: boolean
  sections: TocEntry[]
  divisions: TocDivision[]
}

/** Top-level: extract a spec book PDF's TOC into sections + divisions. */
export async function parseTableOfContents(buffer: Buffer): Promise<TocParseResult> {
  const pages = await extractPdfPages(buffer)
  const totalChars = pages.reduce((sum, p) => sum + p.length, 0)

  if (pages.length > 0 && totalChars / pages.length < 100) {
    return { pageCount: pages.length, needsOcr: true, sections: [], divisions: [] }
  }

  const sections = extractSpecToc(pages)
  return {
    pageCount: pages.length,
    needsOcr: false,
    sections,
    divisions: divisionsFromToc(sections),
  }
}
