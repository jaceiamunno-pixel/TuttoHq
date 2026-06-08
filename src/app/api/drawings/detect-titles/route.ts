import { NextRequest, NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@/lib/supabase/server"

// POST /api/drawings/detect-titles — Drawing Log splitter (ADR-005 Subsystem 1).
//
// TITLE-ONLY AI assist. The client extracts each sheet's deterministic fields
// (sheet_number / discipline_prefix / discipline / revision) locally with the
// pure detectors in src/lib/drawing-detect.ts; the only fuzzy field is the
// sheet TITLE. The client sends just the small per-sheet TITLEBLOCK-CELL text
// (drawing-detect.titleblockPayload — the bottom-right cell, with the DRAWING
// NOTES callout column already excluded) and gets back a clean title.
//
// Pure text in, JSON out — same pattern + model as /api/classify. No file
// bytes transit this route. Read-only: it never writes to the DB or storage.
export const maxDuration = 60

const SYSTEM = `You read a construction drawing TITLEBLOCK text dump and return strict JSON {"title": string|null}.
title = the sheet's short descriptive NAME only — e.g. "GENERAL NOTES", "LEVEL 02 FRAMING PLAN", "INTERIOR DETAILS - STAIRS", "DEMOLITION PLAN - LEVEL 01".
NEVER return note paragraphs, dates, scales, project names, the firm name, or the sheet number.
Return null if no descriptive title is discernible. Output JSON only, no prose.`

interface TitleRowIn { client_row_id?: unknown; titleblock_text?: unknown }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const rowsIn: TitleRowIn[] = Array.isArray(body?.rows) ? body.rows : []
  if (rowsIn.length === 0) return NextResponse.json({ titles: [] })
  if (rowsIn.length > 200) {
    return NextResponse.json({ error: "too many rows (max 200)" }, { status: 400 })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  async function titleFor(text: unknown): Promise<string | null> {
    const t = (typeof text === "string" ? text : "").slice(0, 1500).trim()
    if (!t) return null
    try {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: SYSTEM,
        messages: [{ role: "user", content: t }],
      })
      const out = msg.content[0]?.type === "text" ? msg.content[0].text : ""
      const m = out.match(/\{[\s\S]*\}/)
      if (!m) return null
      const parsed = JSON.parse(m[0]) as { title?: unknown }
      const title = typeof parsed.title === "string" ? parsed.title.trim() : null
      return title || null
    } catch {
      // Title is a nice-to-have; a failed/garbled call just leaves the field
      // blank for manual entry. Never throw the whole batch.
      return null
    }
  }

  const titles = await Promise.all(rowsIn.map(async (r) => ({
    client_row_id: typeof r?.client_row_id === "string" ? r.client_row_id : "",
    title: await titleFor(r?.titleblock_text),
  })))

  return NextResponse.json({ titles })
}
