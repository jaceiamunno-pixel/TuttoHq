import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { extractPdfWords, extractPdfBars } from "@/lib/schedule/pdf-words"
import { parseScheduleWords } from "@/lib/schedule/import-parse"
import { looksLikeCalendar, parseCalendarPages } from "@/lib/schedule/calendar-parse"
import { parsePullPlanXlsx } from "@/lib/schedule/xlsx-parse"

// ── POST /api/schedule-import/parse (ADR-012 + calendar + xlsx follow-ups) ────
// Takes an uploaded schedule file (multipart `file`) and returns proposed task rows
// for the select-scope review UI. This route is READ-ONLY: it writes nothing and
// stores nothing — the file is parsed in memory and discarded. The actual commit
// goes row-by-row through the existing POST /api/schedule-tasks write path, so parse
// and commit stay cleanly separate.
//
// TWO file kinds, structural auto-detect:
//   • PDF → a weekday-header row ("Sunday".."Sat") means a hand-built Bluebeam MONTH
//     CALENDAR → the calendar parser (a second pass reads the colored bar geometry);
//     otherwise it's a tabular MS Project / P6 / Asta export → parseScheduleWords.
//   • XLSX → a THP pull-plan ACTIVITY-LIST intake form (one sheet, one-or-many
//     project blocks) → parsePullPlanXlsx → undated BACKLOG rows (family "pullplan",
//     same destination as the PDF pull-plan path).
// All paths emit the SAME proposed-row shape the review modal renders.
//
// unpdf/pdfjs + exceljs need Node APIs, so this runs on the Node runtime. getUser()
// gates the route (any signed-in tenant may parse — nothing is persisted, no project
// is touched). A 4 MB cap keeps us under Vercel's request-body limit; larger files
// would need the presigned-upload pattern (v2).

export const runtime = "nodejs"

const MAX_BYTES = 4 * 1024 * 1024 // 4 MB — below Vercel's ~4.5 MB body limit
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload" }, { status: 400 })
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 })
  }
  const name = file.name.toLowerCase()
  const isXlsx = name.endsWith(".xlsx") || file.type === XLSX_MIME
  const isPdf = name.endsWith(".pdf") || file.type === "application/pdf"
  if (!isXlsx && !isPdf) {
    return NextResponse.json({ error: "File must be a PDF or an .xlsx spreadsheet" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). The limit is 4 MB.` },
      { status: 413 },
    )
  }

  let result
  try {
    const ab = await file.arrayBuffer()
    if (isXlsx) {
      // THP pull-plan spreadsheet intake form → undated backlog rows.
      result = await parsePullPlanXlsx(ab)
    } else {
      const buffer = Buffer.from(ab)
      const pages = await extractPdfWords(buffer)
      if (looksLikeCalendar(pages)) {
        const bars = await extractPdfBars(buffer) // second pass: bar geometry carries the dates
        result = parseCalendarPages(pages, bars)
      } else {
        result = parseScheduleWords(pages)
      }
    }
  } catch (e) {
    console.error("schedule-import parse failed:", e)
    return NextResponse.json(
      {
        error: isXlsx
          ? "Couldn't read that spreadsheet. Is it a valid .xlsx pull-plan intake form?"
          : "Couldn't read that PDF. Is it a text-based schedule export (not a scan)?",
      },
      { status: 422 },
    )
  }

  // XLSX with no activities resolved → a clear 422 (the PDF pull-plan path keeps its
  // existing 200-with-warning behavior, so this is scoped to the spreadsheet flow).
  if (isXlsx && result.rows.length === 0) {
    return NextResponse.json(
      {
        error: 'No pull-plan activities were found in that spreadsheet. Each project block needs a header row with "Work Activity" plus "Duration" or "Crew Size".',
        ...result,
      },
      { status: 422 },
    )
  }

  if (result.rows.length === 0 && result.family === "unknown") {
    return NextResponse.json(
      { error: "Couldn't find a recognizable schedule table (MS Project, Primavera P6, or Asta) or month calendar. Check that the PDF has a selectable text layer.", ...result },
      { status: 422 },
    )
  }
  if (result.rows.length === 0 && result.family === "calendar") {
    return NextResponse.json(
      { error: "This looks like a month calendar, but no dated tasks were found. Check that task text reads \"{description} , {N} day(s)\" in the day cells.", ...result },
      { status: 422 },
    )
  }

  return NextResponse.json(result)
}
