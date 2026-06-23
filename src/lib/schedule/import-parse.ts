// ── Schedule-import parser (ADR-012) — PURE, no I/O ──────────────────────────
// Turns the positioned text layer of a GC/CM schedule PDF (MS Project, Primavera
// P6, or Asta/PowerProject exports) into proposed schedule_tasks rows for the
// select-scope review UI. Deliberately I/O-free: it takes the already-extracted
// per-page word lists (see pdf-words.ts for the unpdf seam) so every branch is
// unit-testable against synthetic fixtures — no PDF binaries in the repo.
//
// DESIGN (mirrors the brief / ADR-012):
//   • Columns are DERIVED from the header row's word x-positions, per page,
//     never hardcoded. Headers repeat on every page, so we re-detect + stitch.
//   • The right-hand Gantt graphic is ignored. We never read bar geometry; the
//     only structured data is the left task table. Dependencies come ONLY from a
//     text Predecessors column (captured raw, NOT auto-linked — that's v2).
//   • Three date formats: MSP "Mon 12/1/24", P6 "Jan-27-2026"/"27-Mar-25" (+ an
//     optional trailing " A" actual-date flag), Asta "06/04/2025". Start+Finish
//     (+Predecessors) may render as one merged run, so we regex up to two dates
//     out of the whole date region rather than trusting one item per column.
//   • Duration 0 ⇒ is_milestone.
//   • Hierarchy self-selects: when the name column is visibly indented (MSP/P6)
//     we cluster name-x into depth levels; when it is flat (Asta flattens indent
//     to ~1px) we fall back to the summary-row FONT. Either way a uniform
//     depth-stack builds each leaf's phase path.
//   • Low-confidence rows (unparseable date/duration) are flagged needsReview —
//     never silently dropped or guessed.

// ── Inputs ───────────────────────────────────────────────────────────────────

/** One positioned token from the PDF text layer (a getTextContent item, mapped
 *  to displayed orientation so rotated pages parse like upright ones). */
export interface PdfWord {
  x: number // left edge in display space, rounded to int
  y: number // baseline in display space, rounded — HIGHER = nearer the top
  w: number // advance width, rounded
  str: string // the text
  font: string // pdf.js fontName — the only signal that separates Asta summary rows
}
export type PdfPageWords = PdfWord[]

// ── Outputs ──────────────────────────────────────────────────────────────────

export type ScheduleFamily = "msp" | "p6" | "asta" | "calendar" | "unknown"

/** A committable task proposed to the review UI. Group/summary rows are NOT
 *  emitted as tasks — they only contribute their name to descendants' `phase`. */
export interface ProposedTaskRow {
  name: string
  start_date: string | null // YYYY-MM-DD
  end_date: string | null // YYYY-MM-DD
  duration_days: number | null // informational; the write route RE-derives working-day duration
  is_milestone: boolean
  phase: string | null // hierarchy path, e.g. "Buildings D › Foundations"
  wbs_code: string | null // source Activity ID / ID
  predecessors_raw: string | null // raw text ("2SS+1 day"); never auto-linked in v1
  percent_complete: number | null
  resources: string | null
  actual_start_date: string | null // from a P6 " A" suffix on the start date
  actual_end_date: string | null // from a P6 " A" suffix on the finish date
  needsReview: boolean
  reviewReasons: string[]
}

export interface ParseResult {
  family: ScheduleFamily
  pageCount: number
  rows: ProposedTaskRow[]
  warnings: string[]
}

// ── Header / column detection ────────────────────────────────────────────────
// We look for the header labels as discrete words and read their x. Match is
// exact (normalized) so "Task" (the MSP "Task Mode" column) never steals the
// "Task Name" anchor. Some columns are optional and some (P6 Act/Rem Dur) exist
// only to keep their values from polluting the columns we DO read.

type ColKey =
  | "id"
  | "name"
  | "duration"
  | "_actDur"
  | "_remDur"
  | "start"
  | "finish"
  | "pct"
  | "resources"
  | "predecessors"

const HEADER_LABELS: Record<ColKey, string[]> = {
  id: ["activity id", "id"],
  name: ["task name", "activity name"],
  duration: ["duration", "orig"], // P6 "Orig" = Orig Dur
  _actDur: ["act"],
  _remDur: ["rem"],
  start: ["start"],
  finish: ["finish"],
  pct: ["% complete"],
  resources: ["resources"],
  predecessors: ["predecessors"],
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")
const PAD = 4 // x tolerance when bucketing a value to its column anchor

type Anchors = Partial<Record<ColKey, number>> & { name: number }

/** Find the header row on a page and return each column's anchor x. Returns null
 *  when no header is present (e.g. a continuation page whose header didn't repeat
 *  — rare; callers fall back to the previous page's anchors). */
function detectHeader(words: PdfWord[]): { anchors: Anchors; headerY: number } | null {
  const ys = new Set(words.map((w) => Math.round(w.y)))
  let best: { score: number; y: number; anchors: Anchors } | null = null
  for (const y of ys) {
    // Allow the header to span a 7px block (P6 "Orig/Act/Rem" + "Dur" wrap).
    const near = words.filter((w) => Math.abs(w.y - y) <= 7)
    const anchors: Partial<Record<ColKey, number>> = {}
    for (const w of near) {
      const n = norm(w.str)
      for (const key of Object.keys(HEADER_LABELS) as ColKey[]) {
        if (anchors[key] !== undefined) continue
        if (HEADER_LABELS[key].includes(n)) anchors[key] = w.x
      }
    }
    if (anchors.name === undefined) continue
    // A real header has the name column plus at least a start/finish/duration.
    const score =
      (anchors.start !== undefined ? 1 : 0) +
      (anchors.finish !== undefined ? 1 : 0) +
      (anchors.duration !== undefined ? 1 : 0)
    if (score === 0) continue
    if (!best || score > best.score) best = { score, y, anchors: anchors as Anchors }
  }
  return best ? { anchors: best.anchors, headerY: best.y } : null
}

function inferFamily(anchors: Anchors, words: PdfWord[]): ScheduleFamily {
  if (anchors.pct !== undefined || anchors.resources !== undefined) return "asta"
  if (anchors._actDur !== undefined && anchors._remDur !== undefined) return "p6"
  const hasActivityHeader = words.some((w) => {
    const n = norm(w.str)
    return n === "activity name" || n === "activity id"
  })
  if (hasActivityHeader) return "p6"
  if (anchors.start !== undefined && anchors.finish !== undefined) return "msp"
  return "unknown"
}

// ── Date parsing — three families ────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const pad2 = (n: number) => String(n).padStart(2, "0")
const fourDigitYear = (y: number) => (y < 100 ? 2000 + y : y)
const iso = (y: number, m: number, d: number) => `${fourDigitYear(y)}-${pad2(m)}-${pad2(d)}`

/** A date found inside a (possibly merged) cell, with its source span so callers
 *  can strip it out to recover any trailing predecessors text, and an `actual`
 *  flag set when a P6 " A" suffix followed it. */
interface FoundDate {
  isoDate: string
  index: number
  length: number
  actual: boolean
}

// MSP: optional weekday + M/D/YY(YY). The weekday/space may be absent when an
// adjacent cell merged into this run (e.g. "...5/13/262SS+1 day"). The year is a
// plausible 4-digit year (20xx) or 2 digits — so a trailing predecessor digit
// ("...26" + "10FS") can't be glued into a bogus "2610"; it lands in the remainder.
const MSP_RE = /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*)?(\d{1,2})\/(\d{1,2})\/(20\d\d|\d{2})/gi
// P6 style A "Jan-27-2026" and style B "27-Mar-25" — both appear across exports.
const P6_RE = /([A-Za-z]{3})-(\d{1,2})-(20\d\d|\d{2})|(\d{1,2})-([A-Za-z]{3})-(20\d\d|\d{2})/g
// Asta: M/D/YYYY (four-digit year — never weekday-prefixed).
const ASTA_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g

function findDates(text: string, family: ScheduleFamily): FoundDate[] {
  const out: FoundDate[] = []
  const actualAfter = (m: RegExpExecArray) => /^\s*A\b/.test(text.slice(m.index + m[0].length))

  if (family === "p6" || family === "unknown") {
    P6_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = P6_RE.exec(text))) {
      let mo: number, d: number, y: number
      if (m[1]) { mo = MONTHS[m[1].toLowerCase()]; d = Number(m[2]); y = Number(m[3]) }
      else { d = Number(m[4]); mo = MONTHS[m[5].toLowerCase()]; y = Number(m[6]) }
      if (!mo) continue
      out.push({ isoDate: iso(y, mo, d), index: m.index, length: m[0].length, actual: actualAfter(m) })
    }
    if (out.length) return out
  }
  if (family === "asta" || family === "unknown") {
    ASTA_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ASTA_RE.exec(text))) {
      out.push({ isoDate: iso(Number(m[3]), Number(m[1]), Number(m[2])), index: m.index, length: m[0].length, actual: false })
    }
    if (out.length) return out
  }
  // MSP last: its M/D/YY would otherwise swallow Asta's M/D/YYYY ambiguously.
  if (family === "msp" || family === "unknown") {
    MSP_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MSP_RE.exec(text))) {
      out.push({ isoDate: iso(Number(m[3]), Number(m[1]), Number(m[2])), index: m.index, length: m[0].length, actual: false })
    }
  }
  return out
}

// ── Duration ─────────────────────────────────────────────────────────────────

function parseDuration(text: string): { days: number | null; isMilestone: boolean } {
  const m = text.match(/-?\d+(?:\.\d+)?/)
  if (!m) return { days: null, isMilestone: false }
  const n = Math.round(parseFloat(m[0]))
  return { days: n, isMilestone: n === 0 }
}

// ── Row extraction (per page) ────────────────────────────────────────────────

interface RawRow {
  nameX: number
  font: string
  id: string
  name: string
  durationText: string
  dateText: string // start + finish + predecessors buckets, x-ordered
  pctText: string
  resourcesText: string
}

// A leading ID/Activity-ID code: optional letters, an optional dot, then digits
// (137, A8700, PRO.1340, PH3.1000, CO.1000, M.1140). Summary names ("Milestones",
// "PHASE 0-1 …") have a space or letters after the first word and so never match.
const ID_RE = /^[A-Za-z]{0,5}\.?\d[\d.]*$/

/** Page furniture (titles, the timeline-legend swatches, footer block) — never
 *  data rows. Covers the MS Project legend ("Project Summary", "Inactive Task",
 *  "Manual Summary", "Start-only", …) and the run/footer block on every export. */
function isFurniture(text: string): boolean {
  const t = norm(text)
  if (!t) return true
  return /^(finish date|data date|run date|page \d|proj:|project:|filter:|start:|exported on|data updated|remaining (level|work)|actual (level|work)|critical (remaining|milestone)|project summary|summary( milestone)?$|inactive (task|milestone|summary)|manual (task|summary|progress)|duration-only|start-only|finish-only|external (tasks?|milestone)|deadline$|progress$|milestone$|task$|mode$|split$)/.test(
    t,
  )
}

const joinByX = (parts: { x: number; s: string }[]) =>
  parts.slice().sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim()

/** The top y of the footer/legend block. Every export ends in a bordered legend
 *  (Task/Split/Milestone/… swatches) plus a run/footer line; those words are all
 *  furniture and cluster at the page bottom. We take the highest such word (only
 *  when several cluster there, so a lone furniture-shaped task word can't trip it)
 *  and treat everything at-or-below as off-limits — which also drops the
 *  "Project:/Date:" corner that would otherwise merge into the last real row. */
function detectFooterTop(words: PdfWord[], headerY: number): number {
  const cands = words.filter((w) => w.y < headerY * 0.45 && isFurniture(w.str))
  if (cands.length < 3) return Number.NEGATIVE_INFINITY
  return Math.max(...cands.map((w) => w.y))
}

/** The Gantt's left edge for this page. The timeline axis is the text sitting in
 *  the header band to the RIGHT of the last real column; its leftmost x is where
 *  the table ends. A body-row gap (>120px) is a fallback for wide Asta tables.
 *  Returns +Infinity when there is no right-side text to clip (MSP/P6 bodies). */
function detectGanttLeftX(words: PdfWord[], anchors: Anchors, headerY: number): number {
  const realCols: ColKey[] = ["duration", "start", "finish", "pct", "resources", "predecessors"]
  const xs0 = realCols.map((k) => anchors[k]).filter((x): x is number => x !== undefined)
  const rightmost = Math.max(anchors.name, ...xs0)

  let g = Number.POSITIVE_INFINITY
  const zone = words.filter((w) => w.y >= headerY - 22 && w.y <= headerY + 4 && w.x > rightmost + 6)
  if (zone.length) g = Math.min(...zone.map((w) => w.x))

  const startX = anchors.start ?? anchors.finish ?? anchors.duration ?? anchors.name
  const xs = words.filter((w) => w.y < headerY - 1 && w.x > startX + 10).map((w) => w.x).sort((a, b) => a - b)
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] > 120) { g = Math.min(g, (xs[i] + xs[i - 1]) / 2); break }
  }
  return g
}

/** Build raw rows for one page. Seeds come from the WHOLE left region (id + name,
 *  whatever the indentation), so outdented summary rows aren't lost; values are
 *  attached to the nearest seed by y, then bucketed to the nearest column anchor.
 *  Seeding on the name column (not a fixed y-band) survives both P6's 4px
 *  name/value baseline offset and Asta's 3px row pitch. */
function rowsForPage(words: PdfWord[], anchors: Anchors, headerY: number, ganttLeftX: number, footerTop: number): RawRow[] {
  const valueAnchors = (["duration", "_actDur", "_remDur", "start", "finish", "pct", "resources", "predecessors"] as ColKey[])
    .filter((k) => anchors[k] !== undefined)
    .map((k) => ({ k, x: anchors[k]! }))
  if (valueAnchors.length === 0) return []
  const firstValueX = Math.min(...valueAnchors.map((a) => a.x))
  const idAnchor = anchors.id
  const nameAnchor = anchors.name
  const inBody = (w: PdfWord) => w.y < headerY - 1 && w.y > footerTop

  // Seeds: every left-region word, grouped into rows by y (merge within 2px).
  const seeds = new Map<number, { y: number; words: { x: number; s: string; font: string }[] }>()
  for (const w of words) {
    if (!inBody(w) || w.x >= firstValueX - PAD) continue
    let key: number | null = null
    for (const k of seeds.keys()) if (Math.abs(k - w.y) <= 2) { key = k; break }
    if (key === null) key = Math.round(w.y)
    const seed = seeds.get(key) ?? { y: w.y, words: [] }
    seed.words.push({ x: w.x, s: w.str, font: w.font })
    seeds.set(key, seed)
  }
  const seedList = [...seeds.values()].sort((a, b) => b.y - a.y)
  if (seedList.length === 0) return []

  // Bucket each value word to the nearest seed (by y) and column anchor (by x).
  const buckets = seedList.map(() => new Map<ColKey, { x: number; s: string }[]>())
  const seedYs = seedList.map((s) => s.y)
  for (const w of words) {
    if (!inBody(w) || w.x < firstValueX - PAD || w.x >= ganttLeftX) continue
    let bi = 0, bd = Infinity
    for (let i = 0; i < seedYs.length; i++) { const d = Math.abs(seedYs[i] - w.y); if (d < bd) { bd = d; bi = i } }
    let bk: ColKey | null = null, kd = Infinity
    for (const a of valueAnchors) { const d = Math.abs(w.x - a.x); if (d < kd) { kd = d; bk = a.k } }
    if (!bk) continue
    const m = buckets[bi]
    if (!m.has(bk)) m.set(bk, [])
    m.get(bk)!.push({ x: w.x, s: w.str })
  }
  const colText = (m: Map<ColKey, { x: number; s: string }[]>, keys: ColKey[]) =>
    joinByX(keys.flatMap((k) => m.get(k) ?? []))

  const rows: RawRow[] = []
  seedList.forEach((seed, i) => {
    const lw = seed.words.slice().sort((a, b) => a.x - b.x)
    // Peel a leading ID code that sits in the id column.
    let id = ""
    let nameWords = lw
    if (
      lw.length &&
      idAnchor !== undefined &&
      ID_RE.test(lw[0].s.trim()) &&
      lw[0].x < nameAnchor - 10 &&
      Math.abs(lw[0].x - idAnchor) < Math.abs(lw[0].x - nameAnchor)
    ) {
      id = lw[0].s.trim()
      nameWords = lw.slice(1)
    }
    if (nameWords.length === 0) return
    const name = joinByX(nameWords).replace(/[.\s]*…\s*$/, "").replace(/\s*\.\.\.$/, "").trim()
    if (!name || isFurniture(name)) return
    const m = buckets[i]
    rows.push({
      nameX: nameWords[0].x,
      font: nameWords[0].font,
      id,
      name,
      durationText: colText(m, ["duration"]),
      dateText: colText(m, ["start", "finish", "predecessors"]),
      pctText: colText(m, ["pct"]),
      resourcesText: colText(m, ["resources"]),
    })
  })
  return rows
}

// ── Hierarchy → phase path ───────────────────────────────────────────────────

interface DepthRow extends RawRow {
  depth: number
  isGroup: boolean
}

function assignDepths(rows: RawRow[]): DepthRow[] {
  if (rows.length === 0) return []
  const xs = rows.map((r) => r.nameX)
  const spread = Math.max(...xs) - Math.min(...xs)

  let depths: number[]
  if (spread >= 12) {
    // Indentation (MSP/P6): cluster distinct name-x (±3px) into ordered levels.
    const levels: number[] = []
    for (const x of [...xs].sort((a, b) => a - b)) {
      if (!levels.some((l) => Math.abs(l - x) <= 3)) levels.push(x)
    }
    depths = rows.map((r) => levels.findIndex((l) => Math.abs(l - r.nameX) <= 3))
  } else {
    // Flat indent (Asta): the LESS common name-font marks the summary rows.
    const count = new Map<string, number>()
    for (const r of rows) count.set(r.font, (count.get(r.font) ?? 0) + 1)
    const leafFont = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]
    depths = rows.map((r, i) => {
      if (r.font === leafFont) return 3 // leaf
      if (i === 0) return 0 // project root
      const next = rows[i + 1]
      return next && next.font !== leafFont ? 1 : 2 // container vs leaf-parent
    })
  }

  // A row is a group iff some later row is deeper before a row of ≤ its depth.
  return rows.map((r, i) => {
    let isGroup = false
    for (let j = i + 1; j < rows.length; j++) {
      if (depths[j] > depths[i]) { isGroup = true; break }
      if (depths[j] <= depths[i]) break
    }
    return { ...r, depth: depths[i], isGroup }
  })
}

function buildPhasePaths(rows: DepthRow[]): { row: DepthRow; phase: string | null }[] {
  // Drop the project-root group from paths when (a) every outermost group shares
  // one name — the single project title (P6 "2026.03 …", Asta "Construction", the
  // YNHH banner repeated once per page) — AND (b) the hierarchy actually nests
  // deeper below it. Condition (b) keeps a single-phase schedule (MNRR's lone
  // "Phase 1 (Rms …)", whose children are all leaves) from being flattened away.
  const minDepth = Math.min(...rows.map((r) => r.depth))
  const rootNames = new Set(rows.filter((r) => r.isGroup && r.depth === minDepth).map((r) => r.name))
  const hasDeeperGroup = rows.some((r) => r.isGroup && r.depth > minDepth)
  const rootName = rootNames.size === 1 && hasDeeperGroup ? [...rootNames][0] : null

  const stack: { depth: number; name: string }[] = []
  const out: { row: DepthRow; phase: string | null }[] = []
  for (const r of rows) {
    while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop()
    const path = stack.map((s) => s.name).filter((n) => n !== rootName)
    out.push({ row: r, phase: path.length ? path.join(" › ") : null })
    if (r.isGroup) stack.push({ depth: r.depth, name: r.name })
  }
  return out
}

// ── Finalize a raw leaf row → ProposedTaskRow ────────────────────────────────

function finalizeRow(row: RawRow, phase: string | null, family: ScheduleFamily): ProposedTaskRow {
  const reviewReasons: string[] = []
  const { days, isMilestone } = parseDuration(row.durationText)
  if (row.durationText.trim() && days === null) reviewReasons.push("Couldn't read the duration")

  const dates = findDates(row.dateText, family)
  let start_date: string | null = null
  let end_date: string | null = null
  let actual_start_date: string | null = null
  let actual_end_date: string | null = null

  if (isMilestone) {
    const d = dates[0]
    if (d) { start_date = end_date = d.isoDate; if (d.actual) { actual_start_date = d.isoDate; actual_end_date = d.isoDate } }
  } else {
    if (dates[0]) { start_date = dates[0].isoDate; if (dates[0].actual) actual_start_date = dates[0].isoDate }
    if (dates[1]) { end_date = dates[1].isoDate; if (dates[1].actual) actual_end_date = dates[1].isoDate }
  }

  // Predecessors = whatever non-date text remains in the date region.
  let remainder = row.dateText
  for (const d of [...dates].sort((a, b) => b.index - a.index)) {
    remainder = remainder.slice(0, d.index) + " " + remainder.slice(d.index + d.length)
  }
  const predecessors_raw = remainder.replace(/\bA\b/g, " ").replace(/\s+/g, " ").trim() || null

  let percent_complete: number | null = null
  const pctM = row.pctText.match(/(\d+)\s*%/)
  if (pctM) percent_complete = Math.max(0, Math.min(100, Number(pctM[1])))

  if (!start_date) reviewReasons.push("Missing start date")
  if (!isMilestone && !end_date) reviewReasons.push("Missing finish date")

  return {
    name: row.name,
    start_date,
    end_date,
    duration_days: days,
    is_milestone: isMilestone,
    phase,
    wbs_code: row.id.trim() || null,
    predecessors_raw,
    percent_complete,
    resources: row.resourcesText.trim() || null,
    actual_start_date,
    actual_end_date,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Parse the per-page word lists into proposed rows. Headers are re-detected per
 *  page and rows stitched in document order. Group/summary rows shape the phase
 *  paths but are not emitted as committable tasks. */
export function parseScheduleWords(pages: PdfPageWords[]): ParseResult {
  const warnings: string[] = []
  let family: ScheduleFamily = "unknown"
  const rawRows: RawRow[] = []

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    // Dedupe overprinted glyphs (P6 prints summary bands twice).
    const seen = new Set<string>()
    const words = pages[pageIdx].filter((w) => {
      const k = `${Math.round(w.x)}:${Math.round(w.y)}:${w.str}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    // Each table page repeats its own header. A page WITHOUT one is a Gantt-only
    // continuation (e.g. MS Project prints the bar chart on its own pages) — its
    // only text is bar labels, which would parse as junk rows, so skip it.
    const header = detectHeader(words)
    if (!header) {
      warnings.push(`Page ${pageIdx + 1}: no task-table header — skipped (Gantt-only / non-table page).`)
      continue
    }
    const { anchors, headerY } = header
    if (family === "unknown") family = inferFamily(anchors, words)

    const footerTop = detectFooterTop(words, headerY)
    const ganttLeftX = detectGanttLeftX(words, anchors, headerY)
    rawRows.push(...rowsForPage(words, anchors, headerY, ganttLeftX, footerTop))
  }

  // Merge wrapped-name continuation lines — an MSP-only concern: MS Project spills
  // a long task name across rows, each line a name with a COMPLETELY empty value
  // region (no id, duration, or date/predecessor text). P6/Asta use wide tables
  // that never wrap, and P6 has legitimately date-less SUMMARY BANDS that must NOT
  // be folded away — so gate this to MSP. Requiring an empty date region also
  // keeps a mis-parsed data row (which still carries predecessor text) from being
  // swept up and cascading names together.
  const merged: RawRow[] = []
  for (const r of rawRows) {
    const isCont = family === "msp" && !r.id && !r.durationText.trim() && !r.dateText.trim()
    if (isCont && merged.length) merged[merged.length - 1].name += " " + r.name
    else merged.push(r)
  }

  const withDepth = assignDepths(merged)
  const withPhase = buildPhasePaths(withDepth)
  const rows = withPhase
    .filter((p) => !p.row.isGroup && p.row.name) // groups shape paths; only leaves commit
    .map((p) => finalizeRow(p.row, p.phase, family))

  if (rows.length === 0 && merged.length > 0)
    warnings.push("Rows were detected but none resolved to committable tasks — check the column mapping.")

  return { family, pageCount: pages.length, rows, warnings }
}
