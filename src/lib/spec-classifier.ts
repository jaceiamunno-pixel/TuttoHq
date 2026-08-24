import Anthropic from "@anthropic-ai/sdk"

// ─── Controlled vocabulary ───────────────────────────────────────────────────

export const SUBMITTAL_TYPES = [
  "Product Data",
  "Shop Drawing",
  "Sample",
  "Certification",
  "Warranty",
  "O&M Manual",
  "Lab Test",
  "Attic Stock",
  "Other",
] as const

export type SubmittalType = (typeof SUBMITTAL_TYPES)[number]

// Mode-B consolidation labels (one row per type per spec).
export const TYPE_LABELS: Record<SubmittalType, string> = {
  "Product Data": "Product Data",
  "Shop Drawing": "Shop Drawings",
  "Sample": "Samples",
  "Certification": "Certifications & Qualifications",
  "Warranty": "Warranty",
  "O&M Manual": "O&M / Maintenance Data",
  "Lab Test": "Test Reports",
  "Attic Stock": "Attic Stock",
  "Other": "Other Submittals",
}

export interface ClassifiedSubmittal {
  /** The item's own letter (A, B, C…) within its article. NOT unique on its own:
   *  one section can have an "A" under SUBMITTALS, another under QUALITY
   *  ASSURANCE, another under WARRANTY — so the row grain is section + article +
   *  letter, hence `article` below. */
  letter: string
  /** The article this item sits under — the number ("1.4") or, if unnumbered,
   *  the article title. The missing third of the row key that disambiguates
   *  same-letter items across sibling articles. */
  article: string
  /** Derived TAG, not the row key — it never decides how many rows are emitted
   *  (the lettered items do). Kept for filtering / display. */
  type: SubmittalType
  heading: string
  description: string
  /** True when the item is a bare cross-reference to another section
   *  ("See Section 01 30 00…" / "Refer to Section …"). Still emitted (the
   *  benchmark counts it for completeness) but it is not a chase-able
   *  deliverable — the review UI can grey it out. */
  reference_only: boolean
  sub_bullets: string[]
}

// ─── Haiku system prompt (derived from the Submittal Log Build Process rules) ─

const SYSTEM_PROMPT = `You are ITEMIZING the submittal requirements of ONE construction spec section (CSI MasterFormat).

Your output drives ONE row per requirement on a project's submittal log. Follow these rules exactly.

==== THE ONE RULE: ONE ROW PER TOP-LEVEL LETTERED ITEM ====
The text below has ALREADY been filtered upstream to only the PART 1 articles that
carry submittal items — SUBMITTALS (incl. ACTION / INFORMATIONAL / CLOSEOUT
SUBMITTALS), QUALITY ASSURANCE, WARRANTY, GUARANTEES AND WARRANTIES, MAINTENANCE
MATERIAL SUBMITTALS, and DELEGATED DESIGN. Every article present is IN SCOPE — do
NOT second-guess whether an article belongs, and do NOT skip an article.

Emit EXACTLY ONE row for EACH top-level lettered item (A., B., C., …) under EVERY
article in the text. Enumerate the letters mechanically; do not skip, merge, or split:
- Do NOT drop an item because it reads like a qualification, a warranty term, an
  installation instruction, or a bare cross-reference — under these articles they
  all count (see reference_only for cross-references).
- Do NOT merge two lettered items that share a type. Three separately lettered
  warranties are THREE rows, not one "Warranty" row.
- Letters RESTART per article: an "A." under SUBMITTALS and an "A." under WARRANTY
  are two DIFFERENT rows. Record which article each item sits under in "article".
- A nested "1., 2., 3." or "a., b., c." list under a letter is that row's
  sub_bullets, NOT its own row.

==== IGNORE PAGE FURNITURE ====
Running headers / footers are sometimes stitched BETWEEN lettered items — e.g. the
project name, a "City, State  Month D, YYYY" line, a "RESIDENTIAL APPLIANCES 113100 -2"
title/page line, or a "State Project Number 158-0101N" line. These are page
furniture: never a row, never a sub_bullet. Skip them and keep lettering the real items.

==== reference_only ====
Set "reference_only": true when the item's text is merely a pointer to another
section — it begins "See Section <n>…" or "Refer to Section <n>…". STILL emit the
row (the log counts it for completeness), and set "description" to the cross-
reference text itself (e.g. "See Section 01 30 00 - Administrative Requirements").
Otherwise "reference_only": false.

==== type (a DERIVED TAG — never the row key) ====
"type" is a descriptive label only; it NEVER changes how many rows you emit (the
lettered items do). Choose exactly ONE per item:
- "Product Data"   — catalog cuts, data sheets, mfr instructions, MSDS
- "Shop Drawing"   — fabrication/installation drawings, layouts, sections, coordination
- "Sample"         — physical samples, selection samples, verification samples
- "Certification"  — mfr OR installer qualification statements, UL/NEMA listings, signed design data
- "Warranty"       — executed warranty, specimen warranty, an individually-termed warranty
- "O&M Manual"     — maintenance data, cleaning procedures, test schedules
- "Lab Test"       — test reports, evaluation reports (ICC-ES), preconstruction/field tests
- "Attic Stock"    — extra / spare / maintenance materials for the owner
- "Other"          — schedules, cross-references, anything not fitting above

==== SUB-ITEM CONDENSING (sub_bullets) ====
- If a lettered item has nested sub-items (1, 2, 3 or a, b, c), condense each into a
  short comma-separated phrase using construction abbreviations (mfr's, dims, req's,
  install, BMS, fab, accys, ops).
- If the item has no sub-items, return an empty array.

==== OUTPUT SCHEMA ====
Respond with ONLY compact JSON — no markdown, no prose:
{
  "submittals": [
    {
      "letter": "A",
      "article": "1.4",
      "type": "Product Data",
      "heading": "Product Data",
      "description": "Mfr's data: dims, capacity, operating features",
      "reference_only": false,
      "sub_bullets": []
    }
  ]
}

If the text has no lettered items, return: {"submittals": []}
"letter" is the item's own letter. "article" is the article number it sits under
(e.g. "1.4"), or the article title if unnumbered. Keep "description" under 120
characters. "type" MUST be exactly one of the nine allowed values.`

// ─── Classification ──────────────────────────────────────────────────────────

const ALLOWED = new Set<string>(SUBMITTAL_TYPES)

// A bare cross-reference item — "See Section 01 30 00 …" / "Refer to Section …".
// The authoritative reference_only test: applied in code so the flag never
// depends on Haiku's judgment for the terse pointer items it tends to echo back.
const REFERENCE_ONLY_RE = /^(See|Refer to)\s+Section\s+\d/i

function coerceType(raw: unknown): SubmittalType {
  const v = typeof raw === "string" ? raw.trim() : ""
  return (ALLOWED.has(v) ? v : "Other") as SubmittalType
}

function normalize(item: unknown): ClassifiedSubmittal | null {
  if (!item || typeof item !== "object") return null
  const o = item as Record<string, unknown>
  const heading = typeof o.heading === "string" ? o.heading.trim() : ""
  const description = typeof o.description === "string" ? o.description.trim() : ""
  if (!heading && !description) return null
  return {
    letter: typeof o.letter === "string" ? o.letter.trim() : "",
    article: typeof o.article === "string" ? o.article.trim() : "",
    type: coerceType(o.type),
    heading: heading || description,
    description: description || heading,
    // Deterministic first (regex on the item text), Haiku's own flag as backstop.
    reference_only: REFERENCE_ONLY_RE.test(description) || REFERENCE_ONLY_RE.test(heading) || o.reference_only === true,
    sub_bullets: Array.isArray(o.sub_bullets)
      ? o.sub_bullets.filter((s): s is string => typeof s === "string" && s.trim() !== "")
                     .map(s => s.trim())
      : [],
  }
}

/** Sends one spec section's SUBMITTALS text to Claude Haiku.
 *
 *  LEGACY single-shot path — kept exported and behaviorally identical for any
 *  existing caller, but it cannot distinguish "no submittals" from "response
 *  truncated / unparseable" (both return []). The parse pipeline uses
 *  classifySubmittalsChunked below, which reports failures explicitly. */
export async function classifySubmittals(
  client: Anthropic,
  specNumber: string,
  specTitle: string,
  submittalsText: string,
): Promise<ClassifiedSubmittal[]> {
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Spec section: ${specNumber} — ${specTitle}\n\nSUBMITTALS article text:\n${submittalsText}`,
      },
    ],
  })

  const text = message.content[0]?.type === "text" ? message.content[0].text.trim() : ""
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch (err) {
    console.error("[spec-classifier] failed to parse Claude JSON response", err)
    return []
  }

  const items =
    parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).submittals)
      ? ((parsed as Record<string, unknown>).submittals as unknown[])
      : []

  return items.map(normalize).filter((x): x is ClassifiedSubmittal => x !== null)
}

// ─── Chunked classification ──────────────────────────────────────────────────
//
// WHY: a single Haiku call over a whole section's concatenated submittals text
// truncates mid-JSON when the itemization needs more output tokens than
// max_tokens allows; the greedy brace match then finds nothing (or JSON.parse
// throws) and the section silently stages 0 items. Prod evidence: sections
// under ~8,000 chars stage reliably; above ~20,000 chars failure is 100%
// (worst case: a genuine 42,515-char, 109-page section that staged nothing).
// The fix is one call per ARTICLE block, an explicit stop_reason check, and an
// explicit failure count — a failed chunk must never read as "no submittals".

/** A single article block longer than this is sub-chunked at top-level
 *  lettered-item boundaries before being sent. Chosen from prod evidence:
 *  sections under ~8,000 chars classified reliably at the OLD 1,500-token
 *  ceiling, so one ≤8,000-char chunk is comfortably itemized within the new
 *  8,000-token ceiling. */
const MAX_CHUNK_CHARS = 8000

/** Top-level lettered item ("A. ", "B. ") at line start — the same pattern the
 *  item grain is built on. Sub-chunk boundaries fall ONLY here, so a lettered
 *  item is never split across chunks. */
const LETTERED_ITEM_LINE = /^[ \t]*[A-Z]\.\s/

/**
 * Splits one oversized article block into pieces under MAX_CHUNK_CHARS, cutting
 * only at top-level lettered-item boundaries. Every piece after the first is
 * re-anchored with the article's heading line (the block's first line, e.g.
 * "1.4 SUBMITTALS") so the model still knows which article it is itemizing —
 * without it the "article" field of the continuation rows would be wrong.
 * A single lettered item longer than the limit stays whole (never split), even
 * though the resulting piece exceeds the limit.
 */
function subChunkArticle(article: string): string[] {
  if (article.length <= MAX_CHUNK_CHARS) return [article]

  const lines = article.split("\n")
  const headingLine = lines[0]

  // Segment at lettered-item starts: [preamble incl. heading, item A, item B, …]
  const segments: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (LETTERED_ITEM_LINE.test(line) && current.length > 0) {
      segments.push(current.join("\n"))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) segments.push(current.join("\n"))

  // Greedily pack whole segments into chunks under the limit.
  const chunks: string[] = []
  let buf = ""
  for (const seg of segments) {
    if (buf && buf.length + 1 + seg.length > MAX_CHUNK_CHARS) {
      chunks.push(buf)
      buf = `${headingLine}\n${seg}`
    } else {
      buf = buf ? `${buf}\n${seg}` : seg
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

/** One Haiku call over one chunk. ok:false = truncated or unparseable — the
 *  items are incomplete/unknown and MUST NOT pass as a normal (empty) result.
 *  A genuine {"submittals": []} parses cleanly and returns ok:true. */
async function classifyChunk(
  client: Anthropic,
  specNumber: string,
  specTitle: string,
  chunkText: string,
): Promise<{ items: ClassifiedSubmittal[]; ok: boolean }> {
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Spec section: ${specNumber} — ${specTitle}\n\nSUBMITTALS article text:\n${chunkText}`,
      },
    ],
  })

  if (message.stop_reason === "max_tokens") {
    console.error(`[spec-classifier] ${specNumber}: response truncated at max_tokens — chunk marked failed`)
    return { items: [], ok: false }
  }

  const text = message.content[0]?.type === "text" ? message.content[0].text.trim() : ""
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    console.error(`[spec-classifier] ${specNumber}: no JSON object in response — chunk marked failed`)
    return { items: [], ok: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch (err) {
    console.error(`[spec-classifier] ${specNumber}: failed to parse Claude JSON response — chunk marked failed`, err)
    return { items: [], ok: false }
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).submittals)) {
    console.error(`[spec-classifier] ${specNumber}: response JSON has no submittals array — chunk marked failed`)
    return { items: [], ok: false }
  }

  const items = ((parsed as Record<string, unknown>).submittals as unknown[])
    .map(normalize)
    .filter((x): x is ClassifiedSubmittal => x !== null)
  return { items, ok: true }
}

/**
 * Chunked classification of one spec section — the parse pipeline's entry
 * point. One Haiku call per article block, SEQUENTIAL on purpose: the caller
 * already fans sections out through mapWithConcurrency, so adding concurrency
 * here would multiply the total fan-out. Items are concatenated in article
 * order and never deduped — letters legitimately restart per article and the
 * `article` field disambiguates them.
 *
 * failedChunks counts every chunk that truncated, failed to parse, or threw —
 * distinct from a genuine empty result. failedChunks > 0 means the section's
 * itemization is INCOMPLETE and must be surfaced for manual review, never read
 * as "no submittals".
 */
export async function classifySubmittalsChunked(
  client: Anthropic,
  specNumber: string,
  specTitle: string,
  articles: string[],
): Promise<{ items: ClassifiedSubmittal[]; failedChunks: number }> {
  const items: ClassifiedSubmittal[] = []
  let failedChunks = 0

  for (const article of articles) {
    for (const chunk of subChunkArticle(article)) {
      try {
        const result = await classifyChunk(client, specNumber, specTitle, chunk)
        if (result.ok) items.push(...result.items)
        else failedChunks++
      } catch (err) {
        console.error(`[spec-classifier] ${specNumber}: chunk call threw — chunk marked failed`, err)
        failedChunks++
      }
    }
  }

  return { items, failedChunks }
}

/** Runs an async mapper over items with a fixed concurrency ceiling. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  )
  return results
}
