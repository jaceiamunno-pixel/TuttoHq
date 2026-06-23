import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { extractPdfWords, extractPdfBars } from "@/lib/schedule/pdf-words"
import { parseScheduleWords } from "@/lib/schedule/import-parse"
import { looksLikeCalendar, parseCalendarPages } from "@/lib/schedule/calendar-parse"

// ── POST /api/schedule-import/parse (ADR-012 + calendar follow-up) ───────────
// Takes an uploaded schedule PDF (multipart `file`), extracts its text layer with
// positions, and returns proposed task rows for the select-scope review UI. This
// route is READ-ONLY: it writes nothing and stores nothing — the PDF is parsed in
// memory and discarded. The actual commit goes row-by-row through the existing
// POST /api/schedule-tasks write path, so parse and commit stay cleanly separate.
//
// ONE entry point, structural auto-detect: a weekday-header row ("Sunday".."Sat")
// means a hand-built Bluebeam MONTH CALENDAR → the calendar parser (also needs the
// colored bar geometry, so it does a second extraction pass); otherwise it's a
// tabular MS Project / P6 / Asta export → the original parseScheduleWords. Both
// emit the SAME proposed-row shape the review modal renders.
//
// unpdf/pdfjs needs Node APIs, so this runs on the Node runtime. getUser() gates
// the route (any signed-in tenant may parse — nothing is persisted, no project is
// touched). A 4 MB cap keeps us under Vercel's request-body limit; larger files
// would need the presigned-upload pattern (v2).

export const runtime = "nodejs"

const MAX_BYTES = 4 * 1024 * 1024 // 4 MB — below Vercel's ~4.5 MB body limit

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
    return NextResponse.json({ error: "No PDF file provided" }, { status: 400 })
  }
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "File must be a PDF" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `PDF is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). The limit is 4 MB.` },
      { status: 413 },
    )
  }

  let result
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const pages = await extractPdfWords(buffer)
    if (looksLikeCalendar(pages)) {
      const bars = await extractPdfBars(buffer) // second pass: bar geometry carries the dates
      result = parseCalendarPages(pages, bars)
    } else {
      result = parseScheduleWords(pages)
    }
  } catch (e) {
    console.error("schedule-import parse failed:", e)
    return NextResponse.json({ error: "Couldn't read that PDF. Is it a text-based schedule export (not a scan)?" }, { status: 422 })
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
