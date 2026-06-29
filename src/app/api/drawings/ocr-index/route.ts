import { NextRequest, NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@/lib/supabase/server"
import { isPlausibleSheetNumber, normalizeSheetNumber } from "@/lib/drawing-detect"
import { enforceAiLimit } from "@/lib/ratelimit"

// POST /api/drawings/ocr-index — Drawing Log splitter Tier-3 index enrichment.
//
// The client renders a candidate INDEX page (e.g. "INDEX OF DRAWINGS") as one
// downscaled image and POSTs it. Claude Haiku VISION reads the DRAWING NUMBER ->
// DRAWING TITLE table and returns a JSON array. The client joins this onto the
// staged pages by EXACT sheet-number match to fill weak/blank titles — it never
// zips index rows to pages 1:1 (a number can repeat across pages; the index can
// list fewer numbers than the set has pages). This route only READS the table;
// the per-page detected number always remains authoritative.
//
// Read-only. Never throws on a vision error — returns an empty array so the
// import proceeds with whatever per-page detection already produced.

export const maxDuration = 60

const SYSTEM = `You read a construction drawing-set INDEX / SHEET LIST page and return STRICT JSON:
{"rows": [{"sheet_number": string, "title": string}, ...]}.
Read the table that maps a DRAWING NUMBER / SHEET NUMBER to its DRAWING TITLE / SHEET TITLE.
sheet_number = the identifier exactly as printed, e.g. "A-101", "ARC-102", "S-2.01".
title = the descriptive sheet name on that row.
Include ONLY rows where BOTH a sheet number and a title are clearly legible. Do NOT invent rows, do NOT fill gaps, do NOT include header/section labels. If the page is not an index table, return {"rows": []}. Output JSON only, no prose.`

interface IndexRow { sheet_number: string; title: string }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // TIER 2 cost guard (company-keyed, FAIL CLOSED) — see src/lib/ratelimit.ts.
  const limited = await enforceAiLimit(supabase)
  if (limited) return limited

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const image = typeof body?.image === "string" ? body.image : ""
  if (!image) return NextResponse.json({ rows: [] })

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: "Read the drawing index table." },
        ],
      }],
    })
    const out = msg.content[0]?.type === "text" ? msg.content[0].text : ""
    const m = out.match(/\{[\s\S]*\}/)
    if (!m) return NextResponse.json({ rows: [] })
    const parsed = JSON.parse(m[0]) as { rows?: unknown }
    const rawRows = Array.isArray(parsed.rows) ? parsed.rows : []

    // Validate + normalize. Keep only rows whose number matches the Tier-1
    // shape and which carry a title. De-dupe by number (first wins) so the
    // join map is unambiguous; never invent.
    const seen = new Set<string>()
    const rows: IndexRow[] = []
    for (const r of rawRows) {
      const rr = r as Record<string, unknown>
      const num = normalizeSheetNumber(rr?.sheet_number)
      const title = typeof rr?.title === "string" ? rr.title.trim() : ""
      if (!isPlausibleSheetNumber(num) || !title || seen.has(num)) continue
      seen.add(num)
      rows.push({ sheet_number: num, title })
    }
    return NextResponse.json({ rows })
  } catch {
    return NextResponse.json({ rows: [] })
  }
}
