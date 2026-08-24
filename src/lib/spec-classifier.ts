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
  /** The product-group heading the item sits under, when the article groups its
   *  deliverables by product ("11. Door Hardware" → "Door Hardware"). "" when
   *  the item sits directly under the article. Writers use it as the row's
   *  project_item_name, falling back to the section title when empty. */
  group_title: string
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

==== group_title (product-grouped articles) ====
Some sections group their submittals by PRODUCT: a numbered heading
("11. Door Hardware", "12. Aluminum Storefront System") followed by
lettered/sub-lettered deliverables. When an item sits under such a
heading, set "group_title" to that heading's product name EXACTLY as
written, with no number and no trailing punctuation ("Door Hardware").
When an item has no enclosing product heading — it sits directly under
the article — set "group_title" to "". Never invent one, never use the
spec section's own title, never use a page footer or running header.
Use the numbered product heading's own text and nothing else. Do NOT append,
qualify, or compose a more specific title from sub-products, nested headings,
or the item's own content — every item under "11. Door Hardware" gets exactly
"Door Hardware", however varied the items beneath it. One numbered heading =
one group_title, character for character.
The heading is ALWAYS the NUMBERED line. Some groups insert an extra lettered
layer of sub-products between the numbered heading and the deliverables:
  22. Bathroom Accessories
      a. Toilet
         1) Product Data: ...
         2) Warranty: ...
      b. Sink
         1) Product Data: ...
That lettered sub-product layer NEVER contributes to group_title. Every item
above gets group_title "Bathroom Accessories" — never "Toilet", never
"Bathroom Accessories - Toilet", never any joined or hyphenated combination.
The sub-product belongs in the item's heading/description, not in group_title.
HARD CONSTRAINT on every non-empty group_title: the exact string you write
must appear verbatim as the text of ONE numbered heading line in the input,
minus its number and trailing punctuation. Before writing a group_title,
verify it against the input: if that exact string is not the text of a
numbered heading line, it is INVALID — write the enclosing numbered heading's
text instead. A group_title containing " - " is almost always this error.

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
      "group_title": "",
      "heading": "Product Data",
      "description": "Mfr's data: dims, capacity, operating features",
      "reference_only": false,
      "sub_bullets": []
    }
  ]
}

If the text has no lettered items, return: {"submittals": []}
"letter" is the item's own letter. "article" is the article number it sits under
(e.g. "1.4"), or the article title if unnumbered. "group_title" is the enclosing
NUMBERED product heading's name verbatim — never composed with sub-product or
nested-heading names — or "" when there is none. Keep "description" under 120
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

/** Cleans the model's group_title: "" when absent/non-string, and strips the
 *  heading's own number ("11." / "11)") and trailing "." / ":" if the model
 *  echoes them despite the prompt rule. */
function coerceGroupTitle(raw: unknown): string {
  if (typeof raw !== "string") return ""
  return raw
    .trim()
    .replace(/^\d{1,3}[.)]\s*/, "")
    .replace(/[.:]+$/, "")
    .trim()
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
    group_title: coerceGroupTitle(o.group_title),
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

/** A product-group heading line ("11. Door Hardware") — a numbered line whose
 *  text reads as a short title, not a numbered requirement sentence. The length
 *  cap keeps nested numbered sub-bullets ("1. Provide mfr's data for each …",
 *  which run sentence-long) from being mistaken for headings. */
const PRODUCT_HEADING_LINE = /^[ \t]*\d{1,3}[.)][ \t]+\S.{0,78}$/

/**
 * Splits one oversized article block into pieces under MAX_CHUNK_CHARS, cutting
 * only at top-level lettered-item boundaries. Every piece after the first is
 * re-anchored with the article's heading line (the block's first line, e.g.
 * "1.4 SUBMITTALS") so the model still knows which article it is itemizing —
 * without it the "article" field of the continuation rows would be wrong.
 * The same re-anchoring carries the most recent PRODUCT heading ("11. Door
 * Hardware"): a boundary is a lettered-item line, never a product heading, so a
 * continuation chunk can open with deliverables whose enclosing heading stayed
 * in the previous chunk — without the carry those items would lose their
 * group_title.
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

  const lastProductHeading = (text: string): string | null => {
    let found: string | null = null
    for (const l of text.split("\n")) {
      if (PRODUCT_HEADING_LINE.test(l)) found = l
    }
    return found
  }

  // True when the segment's first product heading (if any) comes after its
  // first content line — i.e. the segment opens with material that belongs to
  // a heading it does not contain.
  const opensMidGroup = (seg: string): boolean => {
    for (const l of seg.split("\n")) {
      if (l.trim() === "") continue
      return !PRODUCT_HEADING_LINE.test(l)
    }
    return true
  }

  // Greedily pack whole segments into chunks under the limit, tracking the most
  // recent product heading seen in already-packed text for re-anchoring.
  const chunks: string[] = []
  let buf = ""
  let carriedHeading: string | null = null
  for (const seg of segments) {
    if (buf && buf.length + 1 + seg.length > MAX_CHUNK_CHARS) {
      chunks.push(buf)
      buf = carriedHeading && opensMidGroup(seg)
        ? `${headingLine}\n${carriedHeading}\n${seg}`
        : `${headingLine}\n${seg}`
    } else {
      buf = buf ? `${buf}\n${seg}` : seg
    }
    carriedHeading = lastProductHeading(seg) ?? carriedHeading
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

/** Counting gate bounding concurrent Haiku calls across a whole classify
 *  phase. ONE global ceiling instead of nested per-level limits: sections and
 *  chunks dispatch freely and this gate is the only throttle, so total
 *  in-flight calls is exactly `limit` — never a product of nesting levels
 *  (which under-uses the budget) and never fully sequential per section
 *  (which blows past the route's maxDuration on large books).
 *
 *  A finishing task hands its slot DIRECTLY to the next waiter (resolve
 *  without decrementing) — decrement-then-signal would let a fresh caller
 *  sneak in on the same tick and briefly exceed the limit. */
export class Semaphore {
  private inFlight = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve))
      // Slot handed off by a finishing task — already counted in inFlight.
    } else {
      this.inFlight++
    }
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.inFlight--
    }
  }
}

/**
 * Chunked classification of one spec section — the parse pipeline's entry
 * point. One Haiku call per article block (sub-chunked when oversized). All
 * chunks are dispatched at once; `gate` — shared across every section of the
 * classify phase — is the ONLY concurrency throttle. Results are awaited as an
 * ordered array, so items always concatenate in article order regardless of
 * completion order: letters restart per article and log row order follows
 * article order. Never deduped — the `article` field disambiguates same-letter
 * rows across sibling articles.
 *
 * failedChunks counts every chunk that truncated, failed to parse, or threw —
 * distinct from a genuine empty result. failedChunks > 0 means the section's
 * itemization is INCOMPLETE and must be surfaced for manual review, never read
 * as "no submittals". An EMPTY (or all-whitespace) `articles` input is itself
 * a failure, not a clean zero: callers only reach this for sections whose
 * stored submittals_text is non-empty, so zero articles is a contradiction —
 * a lost association or extraction regression — and must be flagged.
 */
export async function classifySubmittalsChunked(
  client: Anthropic,
  specNumber: string,
  specTitle: string,
  articles: string[],
  gate?: Semaphore,
): Promise<{ items: ClassifiedSubmittal[]; failedChunks: number }> {
  const usable = articles.filter(a => a.trim() !== "")
  if (usable.length === 0) {
    console.error(`[spec-classifier] ${specNumber}: no usable article blocks for a section with submittals_text — marked failed`)
    return { items: [], failedChunks: 1 }
  }

  const chunks = usable.flatMap(subChunkArticle)
  const results = await Promise.all(chunks.map(chunk =>
    (gate ? gate.run(() => classifyChunk(client, specNumber, specTitle, chunk))
          : classifyChunk(client, specNumber, specTitle, chunk)
    ).catch((err): { items: ClassifiedSubmittal[]; ok: boolean } => {
      console.error(`[spec-classifier] ${specNumber}: chunk call threw — chunk marked failed`, err)
      return { items: [], ok: false }
    }),
  ))

  const items: ClassifiedSubmittal[] = []
  let failedChunks = 0
  for (const r of results) {
    if (r.ok) items.push(...r.items)
    else failedChunks++
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
