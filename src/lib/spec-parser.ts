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
  titleSource: "section-prefix" | "bare-same-line" | "lookahead" | "footer-pattern" | "masterformat-fallback"
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
  | "bare-same-line"   // bare number + clean title on same line
  | "lookahead"        // bare number + clean title on the next non-blank line
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

/** Validate + normalize a raw title string. Returns the cleaned title
 *  when it passes (≥ 3 letters, not a body fragment), else null. */
function validateTitle(raw: string): string | null {
  if (!raw) return null
  const stripped = stripQuotesAndPunctuation(raw)
  const cleaned = cleanTitle(stripped)
  if (letterCount(cleaned) < 3) return null
  if (isBodyFragment(cleaned)) return null
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

// Looser fallback: bare number (with or without SECTION prefix) — used for
// tiers 1/2 (bare-same-line + lookahead). The separator is optional here so
// we catch books that don't use a separator after the number.
const SAME_LINE_HEADER =
  /^\s*(?:SECTION\s+)?(\d{2})\s?(\d{2})\s?(\d{2})(?:\.\d{1,2})?\s*(?:[-–—:]\s*)?(.*)$/i

function findCandidatesInPage(
  pageText: string,
  page: number,
  pageStartOffset: number,
): Candidate[] {
  const out: Candidate[] = []
  const lines = pageText.split("\n")
  let offsetInPage = 0

  for (let i = 0; i < lines.length; i++) {
    const lineOffset = offsetInPage
    offsetInPage += lines[i].length + 1

    // Tier 0 — strict: line starts with SECTION + dash/colon separator
    // + clean title same-line. If this matches AND the title validates,
    // emit immediately at the best tier and move on to the next line.
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

    // Tier 1+ — loose match (no SECTION-prefix requirement, separator
    // optional). Used for bare-number headers AND for cross-references
    // that the strict tier 0 deliberately rejected — those land here at
    // tier 1 or 2 and lose to any tier-0 candidate for the same section
    // number elsewhere in the document.
    const m = lines[i].match(SAME_LINE_HEADER)
    if (!m) continue

    const div = m[1]
    if (!VALID_DIVISIONS.has(div)) continue
    const specNumber = `${m[1]} ${m[2]} ${m[3]}`
    if (specNumber === "00 00 00") continue

    const sameLineValid = validateTitle(m[4] ?? "")

    let title = ""
    let tier: TitleTier

    if (sameLineValid !== null) {
      title = sameLineValid
      tier  = "bare-same-line"
    } else {
      // Lookahead — only inspect the FIRST non-blank following line. If
      // THAT line is a body fragment, stop; what follows will be body
      // content too. Prevents skipping past body fragments to grab a
      // later "real-looking" string.
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
  "bare-same-line":   1,
  "lookahead":        2,
  "no-clean-title":   3,
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

// An article heading: a numbered sub-clause like "1.4 SUBMITTALS" whose title
// is upper-case. Used both to locate SUBMITTALS articles and to know where the
// next (non-submittal) article begins.
const ARTICLE_HEADING = /(?:^|\n)[ \t]*(\d{1,2}\.\d{1,2})[ \t]+([A-Z][A-Z0-9 ,/&'’.\-]{2,60})/g

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

/**
 * Extracts every SUBMITTALS-type article (SUBMITTALS, ACTION SUBMITTALS,
 * INFORMATIONAL SUBMITTALS, CLOSEOUT SUBMITTALS) from a section's text. Each
 * article runs until the FIRST of: the next article heading, the next PART
 * heading, or END OF SECTION — so it never reads past its natural end.
 * Returns "" when none are present.
 */
export function extractSubmittalsText(sectionText: string): string {
  const headings: { index: number; title: string }[] = []
  ARTICLE_HEADING.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ARTICLE_HEADING.exec(sectionText)) !== null) {
    headings.push({ index: m.index, title: m[2].trim() })
  }

  const blocks: string[] = []
  for (let i = 0; i < headings.length; i++) {
    if (!/SUBMITTAL/i.test(headings[i].title)) continue
    const start = headings[i].index
    const nextArticle = i + 1 < headings.length ? headings[i + 1].index : sectionText.length
    const hardStop = firstHardStopAfter(sectionText, start + 1)
    blocks.push(sectionText.slice(start, Math.min(nextArticle, hardStop)).trim())
  }
  return blocks.join("\n\n")
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

  const perPage = pages.map((p, i) => findCandidatesInPage(p, i + 1, pageStartOffsets[i]))

  // Drop candidates inside the table-of-contents region. A multi-volume spec
  // book lists every section in its TOC but carries the bodies for only some
  // divisions; without this, a TOC-only section collapses onto the TOC page and
  // becomes a junk "section" whose full_text is the TOC and which has no
  // SUBMITTALS article.
  const tocRegion = detectTocRegion(perPage, pageCount)
  const candidates: Candidate[] = []
  for (let i = 0; i < perPage.length; i++) {
    if (tocRegion && i >= tocRegion.start && i <= tocRegion.end) continue
    candidates.push(...perPage[i])
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
      h.tier === "bare-same-line" ? "bare-same-line" :
      h.tier === "lookahead"      ? "lookahead" :
      "masterformat-fallback"  // placeholder — overwritten below if Layer 2 hits
    let needsTitleReview = false

    if (h.tier === "no-clean-title" || specTitle === "") {
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

  return { pageCount, totalChars, needsOcr: false, sections }
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
