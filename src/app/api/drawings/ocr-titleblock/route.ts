import { NextRequest, NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@/lib/supabase/server"
import { isPlausibleSheetNumber, normalizeSheetNumber, looksLikeRevision } from "@/lib/drawing-detect"

// POST /api/drawings/ocr-titleblock — Drawing Log splitter Tier-2 OCR fallback.
//
// Fires ONLY for pages where the deterministic Tier-1 text detector found no
// sheet number (a text-free / vector-outline CAD set). The CLIENT rasterizes
// two small titleblock strip crops (right edge + bottom edge — titleblocks live
// on one or the other across firms) and POSTs them here as base64 JPEGs. We ask
// Claude Haiku VISION to read the labeled titleblock fields and return strict
// JSON, then RECONCILE the two crops:
//   - validate each read against the SAME sheet-number shape as Tier-1
//   - both crops agree   -> use it
//   - both read a number but DISAGREE -> null + flag (never silent-guess)
//   - only one legible    -> use it
// Same model/pattern as /api/classify + /api/drawings/detect-titles. Read-only:
// never writes DB or storage. Never throws on a vision error — a failed read
// just leaves the row blank (exactly as the import behaves today).

export const maxDuration = 60

const SYSTEM = `You read a construction drawing TITLEBLOCK image crop and return STRICT JSON:
{"sheet_number": string|null, "sub_id": string|null, "sheet_title": string|null, "revision": string|null}.
Read the LABELED titleblock fields only — "DRAWING NO.", "SHEET NO.", "SHEET NUMBER", "DWG NO.", "TITLE", "DRAWING TITLE", "REV".
sheet_number = the PRIMARY sheet identifier (the "DRAWING NO." / "DWG NO." / "SHEET NUMBER" value), e.g. "A-101", "S-2.01", "ARC-102", "M401", "FP-1.1".
sub_id = a SECONDARY "SHEET NO." sub-identifier ONLY when it is clearly distinct from sheet_number (e.g. "06.07.A3"); otherwise null.
sheet_title = the short descriptive NAME, e.g. "SECOND FLOOR DEMOLITION PLAN". Never a note paragraph, date, scale, project name, or firm name.
revision = a revision label if one is clearly printed (e.g. "Rev 2", "Addendum 1"); otherwise null.
If a value is not CLEARLY legible, return null for that field. NEVER guess. Output JSON only, no prose.`

interface CropRead { sheet_number: string | null; sub_id: string | null; sheet_title: string | null; revision: string | null }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const clientRowId = typeof body?.client_row_id === "string" ? body.client_row_id : ""
  const crops: { which: string; b64: unknown }[] = [
    { which: "right", b64: body?.right },
    { which: "bottom", b64: body?.bottom },
  ].filter(c => typeof c.b64 === "string" && (c.b64 as string).length > 0)

  if (crops.length === 0) {
    return NextResponse.json({ client_row_id: clientRowId, sheet_number: null, sheet_title: null, revision: null, flags: [] })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  async function readCrop(b64: string): Promise<CropRead | null> {
    try {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            { type: "text", text: "Read this titleblock crop." },
          ],
        }],
      })
      const out = msg.content[0]?.type === "text" ? msg.content[0].text : ""
      const m = out.match(/\{[\s\S]*\}/)
      if (!m) return null
      const p = JSON.parse(m[0]) as Record<string, unknown>
      return {
        sheet_number: typeof p.sheet_number === "string" ? p.sheet_number : null,
        sub_id: typeof p.sub_id === "string" ? p.sub_id.trim() || null : null,
        sheet_title: typeof p.sheet_title === "string" ? p.sheet_title.trim() || null : null,
        revision: typeof p.revision === "string" ? p.revision.trim() || null : null,
      }
    } catch {
      // A vision error (API/parse/timeout) is isolated to this crop — the row
      // falls back to blank, never throws the request.
      return null
    }
  }

  const reads = await Promise.all(crops.map(async c => ({ which: c.which, read: await readCrop(c.b64 as string) })))

  const flags: string[] = []
  if (reads.every(r => r.read === null)) flags.push("ocr error")

  // Validated sheet-number candidates, normalized, held to the Tier-1 shape.
  const validNums = reads
    .map(r => r.read?.sheet_number)
    .filter((s): s is string => isPlausibleSheetNumber(s))
    .map(s => normalizeSheetNumber(s))
  const uniqueNums = Array.from(new Set(validNums))

  let sheet_number: string | null = null
  if (uniqueNums.length === 1) {
    sheet_number = uniqueNums[0]
  } else if (uniqueNums.length > 1) {
    // Disagreement = flag, never silent-guess (same rule as the bulk-import
    // section detector).
    flags.push("ocr disagreement")
  }

  // Title: prefer the crop that produced the chosen number; else any non-null.
  let sheet_title: string | null = null
  if (sheet_number) {
    const owner = reads.find(r => r.read && normalizeSheetNumber(r.read.sheet_number) === sheet_number)
    sheet_title = owner?.read?.sheet_title ?? null
  }
  if (!sheet_title) sheet_title = reads.map(r => r.read?.sheet_title).find(t => t) ?? null

  // Revision: only accept an OCR revision that matches a real revision shape —
  // otherwise leave null so the client keeps detectRevision / "Rev 0".
  const revision = reads.map(r => r.read?.revision).find(rv => looksLikeRevision(rv)) ?? null

  // Secondary "SHEET NO." sub-identifier — display-only (no schema change),
  // helps the user disambiguate consecutive pages sharing one DRAWING NO.
  // Prefer the crop that owns the chosen number; only keep it if distinct.
  let sub_id: string | null = null
  for (const r of reads) {
    const s = r.read?.sub_id?.trim()
    if (s && normalizeSheetNumber(s) !== sheet_number) { sub_id = s; break }
  }

  return NextResponse.json({ client_row_id: clientRowId, sheet_number, sub_id, sheet_title, revision, flags })
}
