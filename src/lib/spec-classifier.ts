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

/** Sends one spec section's SUBMITTALS text to Claude Haiku. */
export async function classifySubmittals(
  client: Anthropic,
  specNumber: string,
  specTitle: string,
  submittalsText: string,
): Promise<ClassifiedSubmittal[]> {
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
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
