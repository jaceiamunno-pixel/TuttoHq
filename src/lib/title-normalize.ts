// Centralized submittal-title normalization.
//
// Five different code paths write `submittals.file_name`:
//   - /api/staged-submittals/commit (detailed: s.description; consolidated: spec_title)
//   - /api/generate-cover           (user-typed description from the cover modal)
//   - /api/upload                   (custom name or materialName—manufacturer—dimensions)
//   - /api/gmail-intake             (email attachment filename — main + match-back paths)
//
// Each produced a different convention — ALL CAPS spec-book headers, Haiku
// outputs with leading/trailing quotes, Haiku-injected mid-string quote pairs,
// very long run-on descriptions, and em-dash-joined manual uploads. This
// helper is the one place that decides the stored title; every insert path
// calls it.
//
// Design rules:
//   - Strip outer straight + smart quotes (Haiku frequently wraps phrases like
//     `"Modified Bituminous Membrane Roofing" for new roofing`).
//   - Strip orphaned mid-string straight/curly double quotes — when the count
//     of double quotes in the body is odd, ALL are removed so no stray quote
//     survives. Apostrophes (and balanced double-quote pairs) are preserved.
//   - Title-case ALL-CAPS strings while preserving real acronyms (O&M, BMS,
//     HVAC, ASTM, …). A mixed-case string is left alone.
//   - DO NOT TRUNCATE the stored value. Truncation would destroy the only
//     copy of long Haiku descriptions for spec_ingestion rows (no
//     `description` column exists, no storage_path either). The render layer
//     calls `truncateForDisplay(...)` when it needs a short label.
//   - Returns "" for empty input; callers fall back to their own default
//     (filename, safeName, etc.) when the result is "".

/**
 * Acronyms / initialisms preserved verbatim when title-casing an ALL-CAPS
 * source. Add new entries as they show up in spec books — anything not in this
 * list will be title-cased.
 */
export const PRESERVED_ACRONYMS: ReadonlySet<string> = new Set([
  // Maintenance / docs
  "O&M", "MSDS", "SDS", "QA", "QC", "QA/QC",
  // Trades / building systems
  "HVAC", "VAV", "RTU", "AHU", "FCU", "VRF", "VFD", "BMS", "BAS",
  "PVC", "CPVC", "ABS", "HDPE", "PEX", "EPDM", "TPO", "PTFE", "ETFE",
  "GFRC", "FRP", "EIFS", "CMU", "RCP", "GWB", "MDF", "OSB",
  "AFF", "OFCI", "OFOI", "GC", "CM", "AOR", "EOR", "MEP", "FP", "AV",
  "VIF", "TYP", "NIC", "UNO",
  // Standards / orgs
  "ASTM", "ASHRAE", "ANSI", "NFPA", "OSHA", "EPA", "DOE", "FDA",
  "ICC", "ICC-ES", "UL", "ULC", "ACI", "AISC", "AISI", "AWS",
  "AWWA", "AWI", "ISO", "IEEE", "NEC", "NEMA", "ATC",
  "AAMA", "FGMA", "NACE", "SSPC", "USGBC", "CSI",
  // Electrical
  "GFI", "GFCI", "AFCI", "UPS", "ATS", "EPO", "LED", "MCC", "PDU",
  // Roof / waterproofing
  "SBS", "APP", "PMR", "IRMA",
  // Misc abbreviations
  "USA", "US", "UK", "NYC", "LEED", "ADA", "DEP",
])

/** Words that stay lowercase in title case unless they are the first word. */
const LOWERCASE_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "if", "in", "nor",
  "of", "on", "or", "per", "the", "to", "via", "vs", "with",
])

/** Trailing ellipsis used by `truncateForDisplay`. */
const ELLIPSIS = "…"

export interface DisplayOptions {
  /** Maximum display length. Default 80. */
  maxLength?: number
}

/** Strip a balanced run of straight/smart quotes wrapping the whole string. */
function stripOuterQuotes(s: string): string {
  let out = s
  // Repeat — Haiku occasionally double-wraps.
  for (let i = 0; i < 3; i++) {
    const before = out
    out = out.replace(
      /^["'‘’“”«»]+|["'‘’“”«»]+$/g,
      "",
    ).trim()
    if (out === before) break
  }
  return out
}

/** Strip orphaned mid-string double quotes that don't belong to a balanced
 *  pair. Inch marks — a double quote immediately following a digit, e.g.
 *  `25"`, `3/4"`, `96-102"` — are preserved because they're measurement units,
 *  not quotation marks. Apostrophes (single quotes) are always preserved for
 *  possessives ("Mfr's").
 *
 *  Algorithm: find every non-inch-mark double quote. If that count is odd,
 *  there's at least one stray quote in the string; strip ALL non-inch-mark
 *  double quotes so the result is consistent. Balanced quoted phrases
 *  (`He said "hello" to her`) are preserved (count of 2 → no change). */
function stripOrphanedDoubleQuotes(s: string): string {
  const nonInchIndices: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== "\"" && ch !== "“" && ch !== "”") continue
    const prev = i > 0 ? s[i - 1] : ""
    if (/[0-9]/.test(prev)) continue   // inch mark — preserve
    nonInchIndices.push(i)
  }
  if (nonInchIndices.length % 2 === 0) return s

  const drop = new Set(nonInchIndices)
  let out = ""
  for (let i = 0; i < s.length; i++) {
    if (!drop.has(i)) out += s[i]
  }
  return out
}

/** Title-case a single word while preserving known acronyms and lowercase
 *  joiners (handled separately for the first-word rule). */
function titleCaseWord(word: string): string {
  if (word.length === 0) return word

  const upper = word.toUpperCase()
  if (PRESERVED_ACRONYMS.has(upper)) return upper

  if (word.includes("-")) {
    return word.split("-").map(titleCaseWord).join("-")
  }
  if (word.includes("/")) {
    return word.split("/").map(titleCaseWord).join("/")
  }

  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/** Dominantly uppercase? Mixed-case strings are left as-is. */
function isAllCaps(s: string): boolean {
  return /[A-Z]/.test(s) && !/[a-z]/.test(s)
}

/** Title-case a string that has been confirmed to be ALL CAPS. */
function toTitleCase(s: string): string {
  const words = s.split(/(\s+)/) // keep separators
  let firstWordSeen = false
  return words
    .map(token => {
      if (/^\s+$/.test(token)) return token
      if (token.length === 0) return token

      const cased = titleCaseWord(token)
      if (!firstWordSeen) {
        firstWordSeen = true
        return cased
      }
      if (LOWERCASE_WORDS.has(token.toLowerCase())) {
        return token.toLowerCase()
      }
      return cased
    })
    .join("")
}

/**
 * Normalize a raw submittal title for storage in `submittals.file_name`.
 *
 * Pipeline:
 *   1. trim whitespace
 *   2. strip outer straight/smart quotes (handles Haiku quoting artifacts)
 *   3. strip orphaned mid-string double quotes (odd count → remove all)
 *   4. title-case ALL-CAPS inputs (preserves acronyms)
 *
 * Stored value is NOT truncated — the render layer is responsible for capping
 * the visible label via `truncateForDisplay`.
 *
 * Returns "" for empty/whitespace input; callers should fall back to their
 * own default (filename, safeName, …) when the result is "".
 */
export function normalizeSubmittalTitle(
  raw: string | null | undefined,
): string {
  if (raw == null) return ""

  let s = raw.trim()
  if (s.length === 0) return ""

  s = stripOuterQuotes(s)
  if (s.length === 0) return ""

  s = stripOrphanedDoubleQuotes(s)

  if (isAllCaps(s)) s = toTitleCase(s)

  return s
}

/**
 * Render-time truncation for the Library tree + Submittal Log labels. Stored
 * `file_name` keeps the full text; this only shapes the visible string.
 *
 * Breaks at a word boundary when the boundary is past 60% of the cap so
 * single-word run-ons can't collapse to a few characters. The full string is
 * still available via the row's `title=` hover attribute.
 */
export function truncateForDisplay(
  s: string | null | undefined,
  opts: DisplayOptions = {},
): string {
  if (s == null) return ""
  const maxLength = opts.maxLength ?? 80
  if (!Number.isFinite(maxLength)) return s
  if (s.length <= maxLength) return s

  const window = s.slice(0, maxLength)
  const lastSpace = window.lastIndexOf(" ")
  const cut = lastSpace > maxLength * 0.6 ? lastSpace : maxLength
  return s.slice(0, cut).trimEnd() + ELLIPSIS
}
