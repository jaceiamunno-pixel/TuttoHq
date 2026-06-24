import { describe, it, expect } from "vitest"
import { parseCalendarPages, looksLikeCalendar } from "./calendar-parse"
import type { PdfWord, PdfPageWords } from "./import-parse"
import type { PdfBar, PdfPageBars } from "./pdf-words"

// ---------------------------------------------------------------------------
// Synthetic positional fixtures mirroring the REAL geometry measured from the
// three THP calendars (353 Crown / 150 York / 1156 Chapel) — page 2592×1728,
// weekday-header centers ≈224/581/939/1295/1653/2010/2368 (~357 apart), week
// rows ~319 apart, day-numbers right-aligned in each cell, captions centered in
// colored bars. No client PDFs ship in the repo. These exercise the date-from-
// bar anchoring, the day-1-vs-"1 day" trap, multi-task-per-cell splitting, the
// "?" flag, multi-page month concat, and spanning-bar collapse.
// ---------------------------------------------------------------------------

// Weekday header centers (token center = x + w/2). w=0 ⇒ center = x.
const CENTERS = [224, 581, 939, 1295, 1653, 2010, 2368]
const HEADER_Y = 1643
const wd = (): PdfWord[] =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((s, i) => ({
    x: CENTERS[i], y: HEADER_Y, w: 0, str: s, font: "F",
  }))
const monthHdr = (label: string): PdfWord => ({ x: 1247, y: 1659, w: 98, str: label, font: "F" })
const num = (value: number, x: number, y: number): PdfWord => ({ x, y, w: value > 9 ? 11 : 5, str: String(value), font: "F" })
const cap = (str: string, x: number, y: number): PdfWord => ({ x, y, w: str.length * 5, str, font: "F" })
const bar = (x0: number, x1: number, top: number): PdfBar => ({ x0, x1, top, h: 17 })

// Real week-row tops measured on 353 Crown (July): wk1 1630, wk2 1311, wk3 992.
// Day-numbers (right-aligned). Cell boundaries derive to 45/403/760/1117/1475/1832/2189/2547.
const julyDayNums = (): PdfWord[] => [
  num(1, 1469, 1630), num(2, 1826, 1630), num(3, 2184, 1630), num(4, 2541, 1630), // Wed–Sat
  num(5, 397, 1311), num(6, 754, 1311), num(7, 1111, 1311), num(8, 1469, 1311), num(9, 1826, 1311), num(10, 2178, 1311), num(11, 2535, 1311),
  num(12, 391, 992), num(13, 749, 992), num(14, 1106, 992), num(15, 1463, 992), num(16, 1821, 992), num(17, 2178, 992), num(18, 2535, 992),
]

describe("353 Crown — one July page, exactly four tasks, bar-anchored dates", () => {
  // Captions sit RIGHT of their bar's left edge (centered in the bar); the bar
  // start cell is the true date. These are the real measured positions.
  const words: PdfPageWords = [
    ...wd(), monthHdr("July 2026"), ...julyDayNums(),
    cap("Remove Spandrel/Temp In. , 1 day", 1577, 1615),
    cap("Frame/Sheath ADA Ramp., 1 day?", 1936, 1615),
    cap("Replace HM D/F , 1 day", 1601, 1296),
    cap("Spray on fire proofing. , 1 day", 515, 977),
  ]
  const bars: PdfPageBars = [
    bar(1476, 1830, 1626), // Remove Spandrel → Thu, Jul 2
    bar(1833, 2187, 1626), // Frame/Sheath    → Fri, Jul 3
    bar(1476, 1830, 1307), // Replace HM D/F  → Thu, Jul 9
    bar(403, 757, 988),    // Spray           → Mon, Jul 13
  ]
  const r = parseCalendarPages([words], [bars])

  it("emits exactly the four tasks — no phantom rows from the '1 day' digits", () => {
    expect(r.family).toBe("calendar")
    expect(r.rows.map((x) => x.name).sort()).toEqual(
      ["Frame/Sheath ADA Ramp.", "Remove Spandrel/Temp In.", "Replace HM D/F", "Spray on fire proofing."],
    )
  })

  it("dates each task to its bar's START cell (not the centered caption's column)", () => {
    const byName = Object.fromEntries(r.rows.map((x) => [x.name, x]))
    expect(byName["Remove Spandrel/Temp In."].start_date).toBe("2026-07-02")
    expect(byName["Frame/Sheath ADA Ramp."].start_date).toBe("2026-07-03")
    expect(byName["Replace HM D/F"].start_date).toBe("2026-07-09")
    expect(byName["Spray on fire proofing."].start_date).toBe("2026-07-13")
  })

  it("keeps the PM's '?' as needsReview without corrupting the duration", () => {
    const f = r.rows.find((x) => x.name === "Frame/Sheath ADA Ramp.")!
    expect(f.duration_days).toBe(1)
    expect(f.needsReview).toBe(true)
    expect(f.reviewReasons.join(" ")).toMatch(/uncertain/i)
    // The unmarked tasks are clean.
    expect(r.rows.find((x) => x.name === "Remove Spandrel/Temp In.")!.needsReview).toBe(false)
  })
})

describe("multi-day bar anchoring (the case text-position gets wrong)", () => {
  // 150 York "Masonry infill … , 4 days": bar starts Mon (Jul 13) but the caption
  // text is centered and lands in the Tue column. Bar must win → Jul 13, not Jul 14.
  const words: PdfPageWords = [
    ...wd(), monthHdr("July 2026"), ...julyDayNums(),
    cap("Masonry infill window and surrounds of new door., 4 days", 990, 977),
  ]
  const bars: PdfPageBars = [bar(403, 1830, 988)] // Mon→Thu, 4 cells
  const r = parseCalendarPages([words], [bars])

  it("uses the bar's left edge for the start and the working calendar for the end", () => {
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].start_date).toBe("2026-07-13") // Mon, NOT Tue/Jul-14 (text column)
    expect(r.rows[0].duration_days).toBe(4)
    expect(r.rows[0].end_date).toBe("2026-07-16") // Mon+3 working days = Thu
    expect(r.rows[0].is_milestone).toBe(false)
    expect(r.rows[0].phase).toBeNull()
  })
})

describe("day-number vs '1 day' disambiguation trap", () => {
  // A stray standalone "1" sitting mid-cell immediately before a "day" token must
  // NOT be classified as a day-number (which would corrupt the cell→date map).
  const words: PdfPageWords = [
    ...wd(), monthHdr("July 2026"),
    num(1, 1469, 1630), num(2, 1826, 1630), num(3, 2184, 1630), num(4, 2541, 1630),
    // trap: a bare "1" offset right + ~15px below the band top, right before "day"
    { x: 1600, y: 1615, w: 5, str: "1", font: "F" },
    { x: 1620, y: 1615, w: 20, str: "day", font: "F" },
    cap("Pour slab , 1 day", 1577, 1615),
  ]
  const bars: PdfPageBars = [bar(1476, 1830, 1626)] // Thu / Jul 2
  const r = parseCalendarPages([words], [bars])

  it("does not invent a phantom day cell and dates the real task correctly", () => {
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].name).toBe("Pour slab")
    expect(r.rows[0].start_date).toBe("2026-07-02")
  })
})

describe("multiple tasks split out of one caption run, both dated to the cell", () => {
  const words: PdfPageWords = [
    ...wd(), monthHdr("July 2026"), ...julyDayNums(),
    cap("Remove Spandrel/Temp In. , 1 day Frame/Sheath ADA Ramp. , 2 days", 1577, 1615),
  ]
  const bars: PdfPageBars = [bar(1476, 1830, 1626)] // Thu / Jul 2
  const r = parseCalendarPages([words], [bars])

  it("splits on the repeating ', N day(s)' tail without dropping the second", () => {
    expect(r.rows.map((x) => x.name).sort()).toEqual(["Frame/Sheath ADA Ramp.", "Remove Spandrel/Temp In."])
    expect(r.rows.every((x) => x.start_date === "2026-07-02")).toBe(true)
    const frame = r.rows.find((x) => x.name === "Frame/Sheath ADA Ramp.")!
    expect(frame.duration_days).toBe(2)
    expect(frame.end_date).toBe("2026-07-03") // Thu + 1 working day
  })
})

describe("multi-page = consecutive months, concatenated, dated into the right month", () => {
  // June 2026: wk5 row top ~339 (Jun 28–30); June 1 is a Monday so wk5 = Sun28/Mon29/Tue30.
  const junePage: PdfPageWords = [
    ...wd(), monthHdr("June 2026"),
    num(28, 320, 339), num(29, 677, 339), num(30, 1034, 339), // Sun/Mon/Tue, right-aligned
    cap("Concrete placement at ramp., 1 day", 860, 320),
  ]
  const juneBars: PdfPageBars = [bar(761, 1115, 350)] // Tue / Jun 30
  const julyPage: PdfPageWords = [
    ...wd(), monthHdr("July 2026"), ...julyDayNums(),
    cap("Rework ceiling grid for new CUH, 1 day", 1209, 1615),
  ]
  const julyBars: PdfPageBars = [bar(1118, 1472, 1626)] // Wed / Jul 1
  const r = parseCalendarPages([junePage, julyPage], [juneBars, julyBars])

  it("reads each page's own month and dates tasks into it", () => {
    expect(r.pageCount).toBe(2)
    const j = r.rows.find((x) => x.name === "Concrete placement at ramp.")!
    const k = r.rows.find((x) => x.name === "Rework ceiling grid for new CUH")!
    expect(j.start_date).toBe("2026-06-30")
    expect(k.start_date).toBe("2026-07-01")
  })
})

describe("spanning-bar collapse (a multi-week task repeats its caption per row)", () => {
  const words: PdfPageWords = [
    ...wd(), monthHdr("July 2026"), ...julyDayNums(),
    cap("Drywall all furred walls. , 5 days", 1586, 1296), // wk2, real start
    cap("Drywall all furred walls. , 5 days", 333, 977),   // wk3, continuation segment
  ]
  const bars: PdfPageBars = [
    bar(761, 2547, 1307), // wk2 Tue→Sat
    bar(45, 757, 988),    // wk3 Sun→Mon (continuation)
  ]
  const r = parseCalendarPages([words], [bars])

  it("keeps the earliest occurrence and notes the merge", () => {
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].start_date).toBe("2026-07-07") // wk2 Tue
    expect(r.rows[0].duration_days).toBe(5)
    expect(r.warnings.some((w) => /merged/i.test(w))).toBe(true)
  })
})

describe("looksLikeCalendar detection", () => {
  it("is true for a weekday-header page", () => {
    expect(looksLikeCalendar([[...wd(), monthHdr("July 2026")]])).toBe(true)
  })
  it("is false for a tabular schedule header (no weekday row)", () => {
    const tabular: PdfPageWords = [
      { x: 37, y: 538, w: 10, str: "ID", font: "F" },
      { x: 136, y: 538, w: 40, str: "Task Name", font: "F" },
      { x: 342, y: 538, w: 20, str: "Start", font: "F" },
      { x: 418, y: 538, w: 24, str: "Finish", font: "F" },
    ]
    expect(looksLikeCalendar([tabular])).toBe(false)
  })
})
