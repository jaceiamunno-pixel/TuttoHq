import { describe, it, expect } from "vitest"
import { gridFromRows } from "../pco-import/grid"
import { parsePullPlanGrid } from "./xlsx-parse"

// ---------------------------------------------------------------------------
// These tests drive the PURE xlsx core (parsePullPlanGrid) with synthetic Grids
// built by gridFromRows — the same shape the exceljs reader produces from a real
// workbook — so block detection, both layouts, the duration/crew carry, and phase
// composition are covered without shipping any .xlsx binaries into the repo. The
// exceljs I/O seam (parsePullPlanXlsx) is exercised separately by a scratchpad
// script that generates a representative workbook and parses it end-to-end.
// ---------------------------------------------------------------------------

const HEADER = ["Bid Package Responsibility", "Work Activity", "Duration", "Crew Size"]

describe("XLSX pull-plan — single block", () => {
  it("detects a block, carries duration + crew, prefixes phase with the block title", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        ["150 York Corridor", "", "", ""], // colored/merged title cell above the header
        HEADER,
        ["09A THP", "Frame demising walls", "5 DAYS", "2 PEOPLE"],
        ["26A Dinto", "Electrical rough", "", ""], // blank duration + crew → nulls
        ["23A F+F", "Hang doors", "1 DAY", "4 PEOPLE"],
      ]),
    ])

    expect(r.family).toBe("pullplan")
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]).toMatchObject({
      name: "Frame demising walls",
      phase: "150 York Corridor › 09A THP",
      duration_days: 5,
      crew_size: 2,
      start_date: null,
      end_date: null,
      is_milestone: false,
    })
    expect(r.rows[1]).toMatchObject({
      name: "Electrical rough",
      phase: "150 York Corridor › 26A Dinto",
      duration_days: null,
      crew_size: null,
    })
    expect(r.rows[2]).toMatchObject({ name: "Hang doors", duration_days: 1, crew_size: 4 })
    expect(r.warnings[0]).toContain("150 York Corridor (3)")
  })

  it("reads bare-number duration/crew cells (a spreadsheet may store 5, not '5 days')", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        ["Levels 2–4", "", "", ""],
        HEADER,
        ["09A THP", "Layout walls", 3, 2], // numeric cells
      ]),
    ])
    expect(r.rows[0]).toMatchObject({ name: "Layout walls", duration_days: 3, crew_size: 2 })
  })
})

describe("XLSX pull-plan — multiple blocks STACKED vertically", () => {
  it("separates two stacked blocks and attributes rows to the right block", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        ["150 York Corridor", "", "", ""],
        HEADER,
        ["09A THP", "Frame walls", "5 DAYS", "2 PEOPLE"],
        ["26A Dinto", "Pull wire", "2 DAYS", "3 PEOPLE"],
        ["", "", "", ""], // blank separator between blocks
        ["1156 Chapel (interior)", "", "", ""],
        HEADER,
        ["23A F+F", "Trim out", "4 DAYS", "1 PEOPLE"],
      ]),
    ])

    expect(r.rows).toHaveLength(3)
    expect(r.rows.map((x) => x.name)).toEqual(["Frame walls", "Pull wire", "Trim out"])
    expect(r.rows[0].phase).toBe("150 York Corridor › 09A THP")
    expect(r.rows[1].phase).toBe("150 York Corridor › 26A Dinto")
    expect(r.rows[2].phase).toBe("1156 Chapel (interior) › 23A F+F")
    expect(r.warnings[0]).toContain("Detected 2 project blocks")
  })

  it("does not eat the next stacked block's title even with NO blank separator", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        ["Block A", "", "", ""],
        HEADER,
        ["09A THP", "Activity A1", "1 DAY", "1 PEOPLE"],
        ["Block B", "", "", ""], // title sits directly under A's last row (no blank gap)
        HEADER,
        ["26A Dinto", "Activity B1", "2 DAYS", "2 PEOPLE"],
      ]),
    ])
    expect(r.rows.map((x) => x.name)).toEqual(["Activity A1", "Activity B1"])
    expect(r.rows[0].phase).toBe("Block A › 09A THP")
    expect(r.rows[1].phase).toBe("Block B › 26A Dinto")
  })
})

describe("XLSX pull-plan — multiple blocks SIDE-BY-SIDE across columns", () => {
  it("separates two blocks laid out across columns (gap column between them)", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        // cols: 0..3 = block A, 4 = gap, 5..8 = block B
        ["150 York Corridor", "", "", "", "", "353 Crown (Level 1)", "", "", ""],
        [...HEADER, "", ...HEADER],
        ["09A THP", "Frame walls", "5 DAYS", "2 PEOPLE", "", "26A Dinto", "Pull wire", "2 DAYS", "3 PEOPLE"],
        ["09A THP", "Insulate", "1 DAY", "1 PEOPLE", "", "23A F+F", "Trim out", "4 DAYS", "2 PEOPLE"],
      ]),
    ])

    expect(r.rows).toHaveLength(4)
    const byName = Object.fromEntries(r.rows.map((x) => [x.name, x]))
    expect(byName["Frame walls"].phase).toBe("150 York Corridor › 09A THP")
    expect(byName["Insulate"].phase).toBe("150 York Corridor › 09A THP")
    expect(byName["Pull wire"].phase).toBe("353 Crown (Level 1) › 26A Dinto")
    expect(byName["Trim out"].phase).toBe("353 Crown (Level 1) › 23A F+F")
    expect(byName["Pull wire"]).toMatchObject({ duration_days: 2, crew_size: 3 })
  })

  it("handles side-by-side blocks of DIFFERENT lengths (short beside long)", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        ["Short Block", "", "", "", "", "Long Block", "", "", ""],
        [...HEADER, "", ...HEADER],
        ["09A THP", "Only activity", "1 DAY", "1 PEOPLE", "", "26A Dinto", "Long A", "2 DAYS", "2 PEOPLE"],
        ["", "", "", "", "", "26A Dinto", "Long B", "3 DAYS", "2 PEOPLE"], // A is done; B continues
        ["", "", "", "", "", "23A F+F", "Long C", "4 DAYS", "1 PEOPLE"],
      ]),
    ])
    expect(r.rows.filter((x) => x.phase?.startsWith("Short Block"))).toHaveLength(1)
    expect(r.rows.filter((x) => x.phase?.startsWith("Long Block"))).toHaveLength(3)
  })
})

describe("XLSX pull-plan — robustness", () => {
  it("ignores a lone 'Work Activity' cell with no duration/crew/bid-package nearby", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        ["Notes: review the Work Activity list before the meeting", "", ""],
        ["Some prose", "and more", "text"],
      ]),
    ])
    expect(r.rows).toHaveLength(0)
    expect(r.warnings[0]).toContain("No pull-plan activity blocks were found")
  })

  it("emits a row with phase = responsibility only when there is no title above", () => {
    const r = parsePullPlanGrid([
      gridFromRows([
        HEADER, // header at the very top, no title row
        ["09A THP", "Frame walls", "5 DAYS", "2 PEOPLE"],
      ]),
    ])
    expect(r.rows[0].phase).toBe("09A THP")
  })
})
