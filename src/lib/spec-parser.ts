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

interface Candidate {
  specNumber: string
  specTitle: string
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

const HEADER_LINE =
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

    const m = lines[i].match(HEADER_LINE)
    if (!m) continue

    const div = m[1]
    if (!VALID_DIVISIONS.has(div)) continue
    const specNumber = `${m[1]} ${m[2]} ${m[3]}`
    if (specNumber === "00 00 00") continue

    // The title is usually on the same line; if not, look at the next few lines.
    let title = (m[4] ?? "").trim()
    if (title.replace(/[^A-Za-z]/g, "").length < 3) {
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const next = lines[j].trim()
        if (next.replace(/[^A-Za-z]/g, "").length >= 3) { title = next; break }
      }
    }
    title = cleanTitle(title)
    if (title.replace(/[^A-Za-z]/g, "").length < 3) continue

    out.push({ specNumber, specTitle: title, page, globalOffset: pageStartOffset + lineOffset })
  }
  return out
}

/**
 * Picks the real section header among duplicate occurrences of the same spec
 * number. A table-of-contents lists many headers packed close together; a
 * cross-reference is isolated. The genuine header is the one followed by the
 * most body text before the next header — so keep, per spec number, the
 * occurrence with the largest gap to the next candidate in document order.
 */
function dedupeByBodyLength(all: Candidate[], totalChars: number): Candidate[] {
  const ordered = [...all].sort((a, b) => a.globalOffset - b.globalOffset)
  const best = new Map<string, { cand: Candidate; gap: number }>()

  for (let i = 0; i < ordered.length; i++) {
    const gap =
      (i + 1 < ordered.length ? ordered[i + 1].globalOffset : totalChars) -
      ordered[i].globalOffset
    const prev = best.get(ordered[i].specNumber)
    if (!prev || gap > prev.gap) {
      best.set(ordered[i].specNumber, { cand: ordered[i], gap })
    }
  }

  return [...best.values()]
    .map(b => b.cand)
    .sort((a, b) => a.globalOffset - b.globalOffset)
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

  const headers = dedupeByBodyLength(candidates, totalChars)

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
    return {
      specNumber: h.specNumber,
      specTitle: h.specTitle,
      startPage,
      endPage,
      fullText,
      submittalsText: extractSubmittalsText(fullText),
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
