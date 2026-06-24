// ── Bluebeam month-calendar parser (ADR-012, calendar follow-up) — PURE ──────
// The THP PM hand-builds a 7-column month-grid lookahead per job in Bluebeam and
// drops task text into day cells as "{description} , {N} day[s]". This parser
// turns the positioned text layer (see pdf-words.ts) PLUS the colored task-bar
// rectangles into the SAME ProposedTaskRow[] the tabular importer emits, so the
// existing select-scope review modal + POST /api/schedule-tasks commit path are
// reused unchanged. Deliberately I/O-free: it takes the already-extracted per-page
// words + bars so every branch is unit-testable against synthetic positional
// fixtures (no PDF binaries in the repo).
//
// DESIGN (measured against the three real files — derive per page, never hardcode):
//   • COLUMNS: derive 7 day-column centers from the weekday header row
//     ("Sunday".."Saturday"). A least-squares fit over whichever weekdays are
//     present yields a regular grid (survives a missing/garbled header label);
//     column boundaries are the mid-points between centers.
//   • MONTH/YEAR: a month-name token + a 20xx token above the header → the page's
//     calendar month. Multi-page = consecutive months; each page re-derives its
//     own header + month + week bands and the tasks are concatenated.
//   • WEEK BANDS: the day-number tokens ("1".."31") cluster at regular vertical
//     tops; clustering their y's gives the week rows. A short integer token that
//     is immediately followed by "day"/"days" is a DURATION, never a day-number —
//     and in practice the duration lives INSIDE the caption token, so day-numbers
//     are clean standalone digits at grid positions. Either way: a day-number is a
//     1–2 digit token that sits at a week-band top AND in a column band, and is
//     NOT a duration. This is the "day-1 vs '1 day'" trap, handled by position.
//   • DATE = the bar's START cell, NOT the caption's x. The caption is centered in
//     its bar, so a multi-day bar's text drifts right into a later cell; anchoring
//     on the bar's left edge is the only way multi-day tasks date correctly. Each
//     caption is matched to the bar that contains it (same week row, x inside the
//     bar span); the bar's left column → that cell's day-number → start_date.
//     Falls back to the caption's own column when no bar is found (flagged when
//     the duration is > 1 day, since then the date is unreliable).
//   • MULTIPLE TASKS PER CELL: a caption run can hold 2+ tasks ("…, 1 day …, 2
//     days"). We split on the repeating ", N day(s)" tail into separate rows, all
//     dated to that cell. PRESERVE the PM's "?" ("1 day?") — duration stays an int,
//     the row is flagged needsReview, the "?" is noted.
//   • SPANNING BARS: a multi-week task repeats its caption on every week row it
//     covers. We collapse later repeats of the same (name, duration) whose start
//     falls within the first occurrence's working-day span — keeping the earliest,
//     never silently (the merge count is surfaced as a warning).
//   • end_date is derived from the working-day calendar in cpm.ts. is_milestone is
//     always false (calendars carry none); phase is null (no hierarchy in a grid).

import { createWorkingCalendar } from "./cpm"
import type { ParseResult, PdfPageWords, PdfWord, ProposedTaskRow } from "./import-parse"
import type { PdfBar, PdfPageBars } from "./pdf-words"

// ── Constants / small helpers ────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")
const pad2 = (n: number) => String(n).padStart(2, "0")
const center = (w: PdfWord) => w.x + w.w / 2

const cal = createWorkingCalendar() // Mon–Fri, no holidays (matches the write route)

/** Add `n` working days to an ISO date and return ISO. Day 0 = the date itself
 *  (snapped forward to a working day), matching cpm's WorkingCalendar contract. */
function addWorkingDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const out = cal.addWorkingDays(new Date(Date.UTC(y, m - 1, d)), n)
  return `${out.getUTCFullYear()}-${pad2(out.getUTCMonth() + 1)}-${pad2(out.getUTCDate())}`
}

// ── Weekday-header → column grid ─────────────────────────────────────────────

interface Grid {
  bounds: number[] // 8 column boundaries (left of Sun … right of Sat)
  headerY: number
}

/** Cluster tokens into rows by y (within `tol`), returning each row's tokens. */
function rowsByY(words: PdfWord[], tol: number): { y: number; words: PdfWord[] }[] {
  const rows: { y: number; words: PdfWord[] }[] = []
  for (const w of [...words].sort((a, b) => b.y - a.y)) {
    let row = rows.find((r) => Math.abs(r.y - w.y) <= tol)
    if (!row) { row = { y: w.y, words: [] }; rows.push(row) }
    row.words.push(w)
  }
  return rows
}

/** Find the weekday header row and derive a regular 7-column grid from it. */
function detectGrid(words: PdfWord[]): Grid | null {
  let best: { count: number; y: number; pairs: { idx: number; c: number }[] } | null = null
  for (const row of rowsByY(words, 6)) {
    const pairs: { idx: number; c: number }[] = []
    for (const w of row.words) {
      const idx = WEEKDAYS.indexOf(norm(w.str))
      if (idx >= 0 && !pairs.some((p) => p.idx === idx)) pairs.push({ idx, c: center(w) })
    }
    if (pairs.length >= 4 && (!best || pairs.length > best.count)) best = { count: pairs.length, y: row.y, pairs }
  }
  if (!best) return null

  // Least-squares fit center(i) = c0 + pitch*i over the present weekdays, so a
  // missing label can't skew the grid and every column is placed regularly.
  const pts = best.pairs
  const n = pts.length
  const sx = pts.reduce((s, p) => s + p.idx, 0)
  const sy = pts.reduce((s, p) => s + p.c, 0)
  const sxx = pts.reduce((s, p) => s + p.idx * p.idx, 0)
  const sxy = pts.reduce((s, p) => s + p.idx * p.c, 0)
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const pitch = (n * sxy - sx * sy) / denom
  const c0 = (sy - pitch * sx) / n
  if (!(pitch > 0)) return null
  const centers = Array.from({ length: 7 }, (_, i) => c0 + pitch * i)

  const bounds = [centers[0] - pitch / 2]
  for (let i = 1; i < 7; i++) bounds.push((centers[i - 1] + centers[i]) / 2)
  bounds.push(centers[6] + pitch / 2)
  return { bounds, headerY: best.y }
}

/** Column index (0=Sun … 6=Sat) for an x, or -1 if outside the grid. */
function colOf(x: number, bounds: number[]): number {
  for (let c = 0; c < 7; c++) if (x >= bounds[c] && x < bounds[c + 1]) return c
  return -1
}

// ── Month / year ─────────────────────────────────────────────────────────────

function detectMonthYear(words: PdfWord[], headerY: number): { month: number; year: number } | null {
  let month: number | null = null
  let year: number | null = null
  for (const w of words) {
    if (w.y < headerY) continue // month/year sits ABOVE the weekday header
    // A token may be "July", "2026", or a merged "July 2026".
    const mm = /([a-z]+)/i.exec(w.str)
    if (mm && month === null) { const v = MONTHS[mm[1].toLowerCase()]; if (v) month = v }
    const ym = /\b(20\d\d)\b/.exec(w.str)
    if (ym && year === null) year = Number(ym[1])
  }
  return month !== null && year !== null ? { month, year } : null
}

// ── Day-number tokens → week bands + cell→day map ────────────────────────────

const isDigits = (s: string) => /^\d{1,2}$/.test(s.trim())

/** Build the week-band tops and a (band,col)→dayOfMonth map from day-numbers. */
function detectDayCells(words: PdfWord[], grid: Grid): { bands: number[]; cellDay: Map<string, number> } {
  const { bounds, headerY } = grid
  // Day-number candidates: standalone 1–2 digit tokens in [1,31] below the header
  // that are NOT a duration (a digit immediately followed by a "day(s)" token).
  const followedByDay = (w: PdfWord) =>
    words.some((o) => Math.abs(o.y - w.y) <= 6 && o.x > w.x && o.x - (w.x + w.w) < 40 && /^days?\b/i.test(o.str.trim()))
  const cands = words.filter((w) => {
    if (w.y >= headerY || !isDigits(w.str)) return false
    const v = Number(w.str)
    return v >= 1 && v <= 31 && colOf(w.x, bounds) >= 0 && !followedByDay(w)
  })

  // Cluster candidate tops into week bands (descending = top of page first).
  const bands: number[] = []
  for (const w of [...cands].sort((a, b) => b.y - a.y)) {
    if (!bands.some((b) => Math.abs(b - w.y) <= 12)) bands.push(w.y)
  }

  const bandOf = (y: number) => {
    let best = -1
    for (let i = 0; i < bands.length; i++) if (bands[i] + 12 >= y) best = i
    return best
  }
  const cellDay = new Map<string, number>()
  for (const w of cands) {
    const band = bandOf(w.y)
    const col = colOf(w.x, bounds)
    if (band >= 0 && col >= 0) cellDay.set(`${band}:${col}`, Number(w.str))
  }
  return { bands, cellDay }
}

// ── Caption text → one or more tasks ─────────────────────────────────────────

// "{description} , {N} day[s]" with an optional PM "?" flag. The comma is the
// usual separator but we allow it to be absent; the "N day(s)" tail is required.
const DURATION_TAIL = /,?\s*(\d+)\s*days?(\s*\?)?/gi

interface SubTask { name: string; days: number; uncertain: boolean }

/** Split a (possibly multi-task) caption run into its component tasks. */
function splitCaption(text: string): SubTask[] {
  const out: SubTask[] = []
  DURATION_TAIL.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = DURATION_TAIL.exec(text))) {
    const name = text.slice(last, m.index).replace(/[,\s]+$/, "").trim()
    if (name) out.push({ name, days: Number(m[1]), uncertain: !!m[2] })
    last = m.index + m[0].length
  }
  // Trailing text with no duration tail → still surface it (flagged later).
  const tail = text.slice(last).trim()
  if (out.length === 0 && tail) out.push({ name: tail, days: 0, uncertain: false })
  else if (tail && out.length) out.push({ name: tail, days: 0, uncertain: false })
  return out
}

// ── Per-page parse ───────────────────────────────────────────────────────────

interface PageTask extends ProposedTaskRow { _spanEnd: string | null }

function parsePage(words: PdfWord[], bars: PdfBar[], warnings: string[], pageNo: number): PageTask[] {
  const grid = detectGrid(words)
  if (!grid) { warnings.push(`Page ${pageNo}: no weekday header — skipped (not a month calendar?).`); return [] }
  const my = detectMonthYear(words, grid.headerY)
  if (!my) { warnings.push(`Page ${pageNo}: couldn't read the month/year — skipped.`); return [] }
  const { bounds, headerY } = grid
  const { bands, cellDay } = detectDayCells(words, grid)
  if (bands.length === 0) { warnings.push(`Page ${pageNo}: no day-number cells found — skipped.`); return [] }

  const bandOf = (y: number) => {
    let best = -1
    for (let i = 0; i < bands.length; i++) if (bands[i] + 12 >= y) best = i
    return best
  }
  const monthLabel = `${my.year}-${pad2(my.month)}`
  const dateFor = (band: number, col: number) => {
    const day = cellDay.get(`${band}:${col}`)
    return day ? `${monthLabel}-${pad2(day)}` : null
  }

  // Captions = body text tokens that aren't the header, a month/year label, or a
  // bare day-number. Each carries one or more "…, N day" tasks. (Stateless regex
  // here — DURATION_TAIL is global/stateful and reserved for splitCaption.)
  const HAS_DURATION = /\d+\s*days?/i
  const captions = words.filter((w) => w.y < headerY && !isDigits(w.str) && /[a-z]/i.test(w.str) && HAS_DURATION.test(w.str))

  const tasks: PageTask[] = []
  for (const cap of captions) {
    const band = bandOf(cap.y)
    if (band < 0) { warnings.push(`Page ${pageNo}: a task ("${short(cap.str)}") fell outside the week grid — flagged.`) }

    // Anchor the date on the bar that contains this caption (same row, x inside).
    // When bars overlap on a cell (a multi-week continuation bar plus a new task's
    // bar share a column), pick the TIGHTEST one — the greatest left edge that is
    // still at/left of the caption — so each caption binds to its own bar.
    const rowBars = bars.filter((b) => bandOf(b.top) === band)
    const host = rowBars
      .filter((b) => cap.x >= b.x0 - 6 && cap.x <= b.x1 + 6)
      .sort((a, b) => b.x0 - a.x0)[0]
    let startCol = host ? colOf(host.x0 + 4, bounds) : colOf(cap.x, bounds)
    let continuation = false
    let date = band >= 0 && startCol >= 0 ? dateFor(band, startCol) : null
    // Bar starts in a cell with no day-number (spans in from the previous month):
    // walk right to the first dated cell within the bar and flag as a continuation.
    if (!date && host && band >= 0) {
      const endCol = colOf(host.x1 - 4, bounds)
      for (let c = Math.max(0, startCol); c <= (endCol >= 0 ? endCol : 6); c++) {
        const d = dateFor(band, c)
        if (d) { date = d; startCol = c; continuation = true; break }
      }
    }

    for (const sub of splitCaption(cap.str)) {
      const reasons: string[] = []
      const days = sub.days > 0 ? sub.days : null
      if (sub.uncertain) reasons.push(`Duration marked uncertain by the PM ("${sub.days} day?")`)
      if (days === null) reasons.push("Couldn't read the duration")
      if (!date) reasons.push("Couldn't place this task on a day")
      else if (continuation) reasons.push("Bar starts before this month — using the first in-month day")
      else if (!host && (days ?? 1) > 1) reasons.push("No bar found — multi-day date may be off")

      const start_date = date
      const end_date = date && days ? addWorkingDaysIso(date, days - 1) : date
      tasks.push({
        name: sub.name,
        start_date,
        end_date,
        duration_days: days,
        crew_size: null, // calendar tasks carry no crew size
        is_milestone: false,
        phase: null,
        wbs_code: null,
        predecessors_raw: null,
        percent_complete: null,
        resources: null,
        actual_start_date: null,
        actual_end_date: null,
        needsReview: reasons.length > 0,
        reviewReasons: reasons,
        _spanEnd: end_date,
      })
    }
  }
  return tasks
}

const short = (s: string) => (s.length > 40 ? s.slice(0, 37) + "…" : s)

// ── Spanning-bar collapse ────────────────────────────────────────────────────
// A multi-week task repeats its caption on each week row it covers. Collapse a
// later occurrence of the same (name, duration) whose start falls within the
// first occurrence's working-day span — keep the earliest, count the merges.

function collapseSpans(tasks: PageTask[], warnings: string[]): ProposedTaskRow[] {
  const sorted = [...tasks].sort((a, b) =>
    (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999") || a.name.localeCompare(b.name))
  const kept: PageTask[] = []
  let merged = 0
  for (const t of sorted) {
    const cont = kept.find((k) =>
      k.name === t.name && k.duration_days === t.duration_days &&
      t.start_date && k.start_date && k._spanEnd &&
      t.start_date >= k.start_date && t.start_date <= k._spanEnd)
    if (cont) { merged++; continue }
    kept.push(t)
  }
  if (merged > 0) warnings.push(`Merged ${merged} repeated bar segment${merged === 1 ? "" : "s"} of multi-week tasks into their start date.`)
  return kept.map(({ _spanEnd, ...row }) => { void _spanEnd; return row })
}

// ── Detection + entry point ──────────────────────────────────────────────────

/** True when any page carries a weekday header row — i.e. a Bluebeam month
 *  calendar rather than a tabular schedule export. Used to dispatch the parser. */
export function looksLikeCalendar(pages: PdfPageWords[]): boolean {
  for (const words of pages) {
    for (const row of rowsByY(words, 6)) {
      const hits = new Set(row.words.map((w) => WEEKDAYS.indexOf(norm(w.str))).filter((i) => i >= 0))
      if (hits.size >= 5) return true
    }
  }
  return false
}

/** Parse month-calendar pages (words + colored bars) into proposed task rows. */
export function parseCalendarPages(wordPages: PdfPageWords[], barPages: PdfPageBars[]): ParseResult {
  const warnings: string[] = []
  const all: PageTask[] = []
  for (let i = 0; i < wordPages.length; i++) {
    all.push(...parsePage(wordPages[i], barPages[i] ?? [], warnings, i + 1))
  }
  const rows = collapseSpans(all, warnings)
  if (rows.length === 0) warnings.push("No tasks were found in this calendar — check that the PDF has a selectable text layer.")
  return { family: "calendar", pageCount: wordPages.length, rows, warnings }
}
