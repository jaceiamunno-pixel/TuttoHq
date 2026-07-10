import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import Anthropic from "@anthropic-ai/sdk"
import { isProjectTransmittalCopy } from "@/lib/storage-paths"
import { enforceAiLimit } from "@/lib/ratelimit"

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const SELECT = "id, file_name, storage_path, mime_type, file_size, created_at, csi_division, division_name, csi_section, section_name, material_name, manufacturer, dimensions, review_status, ai_confidence, ai_reasoning, status, uploaded_by, project_id, sender_email, received_at, manually_overridden, overridden_by, send_to_type, send_to_company, send_to_contact, send_to_email, send_to_phone, send_to_address, transmitted_by, transmitted_by_company, generated_pdf_path, transmittal_sent_at, transmittal_recipient, submittal_number"

interface AiExpansion {
  terms: string[]
  divisions: string[]
  sections: string[]
  summary: string
}

async function aiExpandQuery(query: string): Promise<AiExpansion> {
  if (!process.env.ANTHROPIC_API_KEY) return { terms: [query], divisions: [], sections: [], summary: "" }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response  = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `You are a construction document expert helping search a submittal library.

User query: "${query}"

Return ONLY a JSON object with no extra text:
{
  "terms": ["term1", "term2"],
  "divisions": ["09", "07"],
  "sections": ["09 22 16"],
  "summary": "one short phrase describing what you searched for"
}

Rules:
- terms: 1-4 search terms capturing intent, synonyms, and related construction terminology
- divisions: CSI MasterFormat division numbers (2-digit strings) clearly related to the query (0-3 max)
- sections: specific CSI section codes only if the query strongly implies one (0-3 max)
- summary: e.g. "roofing membranes and waterproofing" or "HVAC ductwork"`,
      }],
    })

    const raw   = response.content[0].type === "text" ? response.content[0].text : ""
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return { terms: [query], divisions: [], sections: [], summary: "" }
    const parsed = JSON.parse(match[0])
    return {
      terms:     Array.isArray(parsed.terms)     ? parsed.terms     : [query],
      divisions: Array.isArray(parsed.divisions) ? parsed.divisions : [],
      sections:  Array.isArray(parsed.sections)  ? parsed.sections  : [],
      summary:   typeof parsed.summary === "string" ? parsed.summary : "",
    }
  } catch (err) {
    console.error("[search] AI query expansion failed, falling back to literal terms", err)
    return { terms: [query], divisions: [], sections: [], summary: "" }
  }
}

// GET /api/search?q=concrete
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // TIER 2 cost guard (company-keyed, FAIL CLOSED). This is a GET, but it calls
  // Claude Haiku, so it is intentionally in the expensive set — see ratelimit.ts.
  const limited = await enforceAiLimit(supabase)
  if (limited) return limited

  const q = req.nextUrl.searchParams.get("q")?.trim()
  if (!q) return NextResponse.json({ files: [] })

  // AI expansion first (Haiku ~200ms), then all DB queries in parallel
  const ai = await aiExpandQuery(q)

  // Build one async fn per query so Promise.all can run them together
  const queryFns: (() => Promise<Row[]>)[] = []

  // 1. Case-insensitive filename match on original query
  queryFns.push(async () => {
    const { data } = await supabase.from("submittals").select(SELECT)
      .eq("status", "active").ilike("file_name", `%${q}%`)
      .order("created_at", { ascending: false }).limit(30)
    return data ?? []
  })

  // Full-text search on search_vector is intentionally omitted — that column
  // includes ai_reasoning which causes false positives (e.g. "acoustic" matching
  // metal framing because reasoning mentions "acoustic ceiling support").

  // 3. AI-expanded terms — ilike on each additional term
  for (const term of ai.terms) {
    if (term.toLowerCase() !== q.toLowerCase()) {
      const t = term
      queryFns.push(async () => {
        const { data } = await supabase.from("submittals").select(SELECT)
          .eq("status", "active").ilike("file_name", `%${t}%`)
          .order("created_at", { ascending: false }).limit(20)
        return data ?? []
      })
    }
  }

  // 4. AI-identified CSI sections
  if (ai.sections.length > 0) {
    queryFns.push(async () => {
      const { data } = await supabase.from("submittals").select(SELECT)
        .eq("status", "active").in("csi_section", ai.sections)
        .order("created_at", { ascending: false }).limit(30)
      return data ?? []
    })
  }

  // Division-level queries are intentionally omitted — too coarse, returns
  // unrelated files from the same division (e.g. searching "acoustical ceiling"
  // would pull all of Division 09 including unrelated metal framing).

  const resultArrays = await Promise.all(queryFns.map(fn => fn()))

  // Merge and deduplicate
  const seen    = new Set<string>()
  const allRows: Row[] = []
  for (const rows of resultArrays) {
    for (const row of rows) {
      if (seen.has(row.id)) continue
      // Skip project transmittal copies — they belong to a Submittal Log, not the Library.
      if (isProjectTransmittalCopy(row.storage_path)) continue
      seen.add(row.id)
      allRows.push(row)
    }
  }

  // Generate signed URLs
  const paths      = allRows.map(r => r.storage_path).filter(Boolean) as string[]
  const signedUrls: Record<string, string> = {}
  if (paths.length > 0) {
    const { data: urlData } = await supabase.storage
      .from("submittals").createSignedUrls(paths, 604800)
    for (const u of urlData ?? []) {
      if (u.path && u.signedUrl) signedUrls[u.path] = u.signedUrl
    }
  }

  const files = allRows.slice(0, 50).map(r => ({
    ...r,
    file_url: r.storage_path ? (signedUrls[r.storage_path] ?? "") : "",
  }))

  return NextResponse.json({ files, aiSummary: ai.summary || null })
}
