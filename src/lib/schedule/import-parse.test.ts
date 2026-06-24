import { describe, it, expect } from "vitest"
import { parseScheduleWords, type PdfPageWords, type PdfWord } from "./import-parse"

// ---------------------------------------------------------------------------
// These tests drive the PURE parser with synthetic positioned-word fixtures —
// the same shape pdf-words.ts produces from unpdf. They mirror the real-corpus
// geometry observed for the three export families (MS Project, Primavera P6,
// Asta/PowerProject) without shipping any client PDF binaries into the repo.
// ---------------------------------------------------------------------------

const w = (x: number, y: number, str: string, opts: { font?: string; w?: number } = {}): PdfWord => ({
  x, y, w: opts.w ?? str.length * 5, str, font: opts.font ?? "F",
})
const page = (...words: PdfWord[]): PdfPageWords => words
const doc = (...words: PdfWord[]): PdfPageWords[] => [words] // a one-page document

// ── MS Project ───────────────────────────────────────────────────────────────

describe("MS Project family", () => {
  // Header: ID@37 · Task Name@136 · Duration@291 · Start@342 · Finish@418
  const header = (y = 538) => [
    w(37, y, "ID"), w(136, y, "Task Name"), w(291, y, "Duration"), w(342, y, "Start"), w(418, y, "Finish"),
  ]

  it("detects the family and parses a row with separate date columns", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(49, 484, "1"), w(139, 484, "Pre-Construction"), w(291, 484, "1 day"),
      w(342, 484, "Sun 12/1/24"), w(418, 484, "Sun 12/1/24"),
    ))
    expect(r.family).toBe("msp")
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      name: "Pre-Construction", wbs_code: "1",
      start_date: "2024-12-01", end_date: "2024-12-01", duration_days: 1, is_milestone: false,
    })
  })

  // MNRR-style narrow header where Start/Finish/Predecessors crowd together and
  // their values often merge into one run: ID@49 · Task Name@150 · Duration@330 ·
  // Start@391 · Finish@452 · Predecessors@513.
  const mnrrHeader = (y = 565) => [
    w(49, y, "ID"), w(150, y, "Task Name"), w(330, y, "Duration"),
    w(391, y, "Start"), w(452, y, "Finish"), w(513, y, "Predecessors"),
  ]

  it("splits a MERGED Start+Finish+Predecessors run and keeps predecessors raw (not linked)", () => {
    const r = parseScheduleWords(doc(
      ...mnrrHeader(),
      w(49, 470, "3"), w(150, 470, "Verde Electrical Demo"), w(330, 470, "2 days"),
      // One glued run, exactly as MS Project narrow columns emit it:
      w(391, 470, "Tue 5/12/26 Wed 5/13/262SS+1 day", { w: 167 }),
    ))
    expect(r.rows[0]).toMatchObject({
      name: "Verde Electrical Demo",
      start_date: "2026-05-12", end_date: "2026-05-13",
      predecessors_raw: "2SS+1 day",
    })
  })

  it("never glues a trailing predecessor digit into the year (5/26/2610FS ⇒ 2026, not 2610)", () => {
    const r = parseScheduleWords(doc(
      ...mnrrHeader(),
      w(49, 470, "9"), w(150, 470, "Install Grid"), w(330, 470, "3 days"),
      w(391, 470, "Fri 5/22/26 Tue 5/26/2610FS-2 days", { w: 160 }),
    ))
    expect(r.rows[0].end_date).toBe("2026-05-26")
    expect(r.rows[0].predecessors_raw).toBe("10FS-2 days")
  })

  it("flags a zero-duration row as a milestone (start = end)", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(49, 460, "5"), w(150, 460, "Building Watertight"), w(291, 460, "0 days"),
      w(342, 460, "Thu 5/14/26"), w(418, 460, "Thu 5/14/26"),
    ))
    expect(r.rows[0].is_milestone).toBe(true)
    expect(r.rows[0].start_date).toBe(r.rows[0].end_date)
  })

  it("merges a wrapped (multi-line) task name back into one row", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(49, 484, "12"), w(150, 484, "Demolition &"), w(330, 484, "3 days"),
      w(342, 484, "Mon 2/10/25"), w(418, 484, "Wed 2/12/25"),
      // continuation lines: name only, no id/duration/date
      w(150, 470, "Abatement"),
      w(150, 456, "(Basement)"),
    ))
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].name).toBe("Demolition & Abatement (Basement)")
  })

  it("flags a row with a blank date column needsReview rather than dropping it", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(49, 484, "35"), w(150, 484, "Punch-out"), w(330, 484, "5 days"),
    ))
    expect(r.rows[0].needsReview).toBe(true)
    expect(r.rows[0].reviewReasons.join(" ")).toMatch(/start/i)
  })

  it("builds an indentation-based phase path and excludes summary rows", () => {
    const row = (y: number, id: string, x: number, name: string) =>
      [w(49, y, id), w(x, y, name), w(291, y, "3 days"), w(342, y, "Mon 2/10/25"), w(418, y, "Wed 2/12/25")]
    // Two distinct top-level summaries (x=139) so neither is treated as the single
    // droppable project root: Pre-Construction→Kickoff, Construction→Phase 1→Pour.
    const r = parseScheduleWords(doc(
      ...header(),
      ...row(498, "1", 139, "Pre-Construction"),
      ...row(484, "2", 162, "Kickoff"),
      ...row(470, "8", 139, "Construction"),
      ...row(456, "10", 162, "Phase 1"),
      ...row(442, "11", 185, "Pour footings"),
    ))
    expect(r.rows.find((x) => x.name === "Pour footings")!.phase).toBe("Construction › Phase 1")
    expect(r.rows.find((x) => x.name === "Kickoff")!.phase).toBe("Pre-Construction")
    // Summary rows are structure, not committable tasks:
    expect(r.rows.some((x) => x.name === "Construction" || x.name === "Phase 1")).toBe(false)
  })
})

// ── Primavera P6 ─────────────────────────────────────────────────────────────

describe("Primavera P6 family", () => {
  // Activity ID@39 · Activity Name@114 · Orig@422 · Act@453 · Rem@480 · Start@537 · Finish@617
  const header = (y = 747) => [
    w(39, y, "Activity ID"), w(114, y, "Activity Name"),
    w(422, y, "Orig"), w(453, y, "Act"), w(480, y, "Rem"), w(537, y, "Start"), w(617, y, "Finish"),
  ]

  it("parses Mon-DD-YYYY dates, captures a P6 ' A' actual suffix, and keeps Act/Rem out of the columns", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(120, 721, "INSTALL UNDERSLAB PLUMBING"),
      w(422, 721, "15"), w(453, 721, "25"), w(480, 721, "4"), // Orig/Act/Rem
      w(519, 721, "Mar-16-2026 A"), w(605, 721, "Apr-24-2026"),
    ))
    expect(r.family).toBe("p6")
    expect(r.rows[0]).toMatchObject({
      start_date: "2026-03-16", end_date: "2026-04-24",
      actual_start_date: "2026-03-16", actual_end_date: null,
      duration_days: 15, // Orig Dur, not Act(25)/Rem(4)
    })
  })

  it("parses the DD-Mon-YY style and a 0-duration milestone", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(120, 721, "M.1140 Trade Complete"), w(422, 721, "0"), w(617, 721, "27-Mar-25"),
    ))
    expect(r.rows[0].is_milestone).toBe(true)
    expect(r.rows[0].start_date).toBe("2025-03-27")
  })

  it("dedupes overprinted (bold) glyphs so a doubled summary band is one row", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      w(120, 721, "MASONRY"), w(422, 721, "10"), w(537, 721, "Mar-24-2026"), w(617, 721, "Apr-27-2026"),
      // exact-duplicate overprint:
      w(120, 721, "MASONRY"), w(422, 721, "10"), w(537, 721, "Mar-24-2026"), w(617, 721, "Apr-27-2026"),
    ))
    expect(r.rows.filter((x) => x.name === "MASONRY")).toHaveLength(1)
  })
})

// ── Asta / PowerProject ──────────────────────────────────────────────────────

describe("Asta / PowerProject family", () => {
  // ID@59 · Task Name@72 · Start@92 · Finish@104 · Duration@119 · % Complete@130 · Resources@141
  const header = (y = 698) => [
    w(59, y, "ID"), w(72, y, "Task Name"), w(92, y, "Start"), w(104, y, "Finish"),
    w(119, y, "Duration"), w(130, y, "% Complete"), w(141, y, "Resources"),
  ]
  // Asta flattens indentation to ~1px; hierarchy lives in the FONT. Leaf font ("L")
  // must dominate (it does in real files — hundreds of leaves), summary font "G".
  const leaf = (y: number, id: string, name: string, s: string, f: string, dur: string, pct: string, res?: string) => [
    w(59, y, id), w(70, y, name, { font: "L" }), w(92, y, s), w(104, y, f), w(119, y, dur), w(130, y, pct),
    ...(res ? [w(141, y, res)] : []),
  ]
  const group = (y: number, id: string, name: string, x = 69) => [w(59, y, id), w(x, y, name, { font: "G" })]

  it("uses FONT (not indentation) for hierarchy, parses M/D/YYYY + %, drops the project root", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      ...group(694, "1", "Construction"),          // root (dropped: nests deeper)
      ...group(690, "2", "Sitework & Utilities"),  // leaf-parent directly under root
      ...leaf(687, "3", "Mobilization", "06/04/2025", "06/17/2025", "10 d", "100%", "APC"),
      ...leaf(683, "4", "Mass Excavation", "06/18/2025", "03/12/2026", "70 d", "100%"),
      ...leaf(680, "5", "Set Rough Grades", "09/22/2025", "02/02/2026", "25 d", "100%"),
      ...leaf(676, "6", "Complete Water", "03/09/2026", "03/13/2026", "5 d", "40%"),
      ...group(655, "12", "Buildings D"),           // container (next row is a group)
      ...group(651, "13", "Foundations"),           // leaf-parent
      ...leaf(648, "14", "Excavate", "09/11/2025", "10/08/2025", "7 d", "0%"),
      ...leaf(644, "15", "Backfill", "11/10/2025", "12/08/2025", "10 d", "0%"),
    ))
    expect(r.family).toBe("asta")
    const mob = r.rows.find((x) => x.name === "Mobilization")!
    expect(mob).toMatchObject({ start_date: "2025-06-04", end_date: "2025-06-17", percent_complete: 100, resources: "APC" })
    expect(mob.phase).toBe("Sitework & Utilities")
    expect(r.rows.find((x) => x.name === "Excavate")!.phase).toBe("Buildings D › Foundations")
    expect(r.rows.some((x) => x.name === "Construction")).toBe(false)
  })
})

// ── THP pull-plan activity list (undated → backlog) ──────────────────────────

describe("Pull-plan activity list family", () => {
  // Mirrors the real Gilbane geometry: CENTERED headers, "Duration Crew Size" MERGED
  // into one token, the responsibility code LEFT of the name (x≈36) vs the name (x≈184),
  // values right (DAY@451 / PEOPLE@522), a wrapped name, and a blank-duration/crew row.
  const header = () => [
    w(68, 753, "Bid Package"), w(63, 734, "Responsibility"),
    w(270, 734, "Work Activity"), w(454, 732, "Duration Crew Size"),
  ]

  it("detects family=pullplan and emits undated backlog rows with crew_size + responsibility→phase", () => {
    const r = parseScheduleWords(doc(
      ...header(),
      // Row A: THP, 1 DAY, 2 PEOPLE, name wraps across two lines
      w(38, 712, "THP"), w(451, 712, "1 DAY"), w(522, 712, "2 PEOPLE"),
      w(184, 713, "frame demising wall"), w(184, 693, "rooms 120 and 121"),
      // Row B: sub responsibility, BLANK duration + crew (intake gap — still valid)
      w(36, 653, "26A Dinto"), w(184, 653, "Electrical rough"),
      // Row C: sub responsibility WITH duration + crew
      w(36, 633, "09A THP"), w(184, 633, "Sheetrock"), w(451, 632, "5 DAY"), w(522, 632, "2 PEOPLE"),
    ))
    expect(r.family).toBe("pullplan")
    expect(r.rows).toHaveLength(3)

    const a = r.rows[0]
    expect(a).toMatchObject({
      name: "frame demising wall rooms 120 and 121",
      phase: "THP", duration_days: 1, crew_size: 2,
      start_date: null, end_date: null, is_milestone: false,
    })
    expect(a.needsReview).toBe(true) // wrapped name → flagged for a glance

    // Blank duration + crew still emits, name only.
    expect(r.rows[1]).toMatchObject({
      name: "Electrical rough", phase: "26A Dinto",
      duration_days: null, crew_size: null, start_date: null, end_date: null,
    })

    expect(r.rows[2]).toMatchObject({
      name: "Sheetrock", phase: "09A THP", duration_days: 5, crew_size: 2,
    })
  })
})

// ── Cross-cutting ────────────────────────────────────────────────────────────

describe("robustness across families", () => {
  it("excludes the footer/legend block (Project:/Date:/swatch legend)", () => {
    const r = parseScheduleWords(doc(
      w(37, 538, "ID"), w(136, 538, "Task Name"), w(291, 538, "Duration"), w(342, 538, "Start"), w(418, 538, "Finish"),
      w(49, 212, "22"), w(150, 212, "Pad Out Ceilings"), w(330, 212, "1 day"), w(342, 212, "Wed 6/24/26"), w(418, 212, "Wed 6/24/26"),
      // footer/legend cluster (y well below header, ≥3 furniture words):
      w(192, 163, "Task"), w(192, 147, "Split"), w(192, 131, "Milestone"), w(192, 114, "Summary"),
      w(41, 122, "Project: MNRR Stamford MOE -"), w(41, 109, "Date: Mon 5/4/26"),
    ))
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].name).toBe("Pad Out Ceilings")
    expect(r.rows[0].end_date).toBe("2026-06-24")
  })

  it("skips a Gantt-only continuation page that has no task-table header", () => {
    const tablePage = page(
      w(37, 538, "ID"), w(136, 538, "Task Name"), w(291, 538, "Duration"), w(342, 538, "Start"), w(418, 538, "Finish"),
      w(49, 484, "1"), w(150, 484, "Real Task"), w(330, 484, "2 days"), w(342, 484, "Mon 5/11/26"), w(418, 484, "Tue 5/12/26"),
    )
    const ganttOnlyPage = page(
      w(150, 484, "Real Task"), w(150, 470, "Another bar label"), // bar labels, no header
    )
    const r = parseScheduleWords([tablePage, ganttOnlyPage])
    expect(r.rows).toHaveLength(1)
    expect(r.warnings.some((wn) => /no task-table header/.test(wn))).toBe(true)
  })

  it("returns family 'unknown' with no rows when there is no recognizable header", () => {
    const r = parseScheduleWords(doc(w(10, 500, "just"), w(60, 500, "some"), w(110, 500, "prose")))
    expect(r.family).toBe("unknown")
    expect(r.rows).toHaveLength(0)
  })
})
