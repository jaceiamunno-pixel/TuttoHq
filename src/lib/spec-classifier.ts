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
  letter: string
  type: SubmittalType
  heading: string
  description: string
  sub_bullets: string[]
}

// ─── Haiku system prompt (derived from the Submittal Log Build Process rules) ─

const SYSTEM_PROMPT = `You are extracting submittal requirements from the SUBMITTALS article of a construction spec section (CSI MasterFormat).

Your output drives row generation on a project's submittal log. Follow these rules exactly.

==== ALLOWED TYPES (Column D — controlled vocabulary) ====
Choose exactly ONE per item:
- "Product Data"   — catalog cuts, data sheets, mfr instructions, MSDS
- "Shop Drawing"   — fabrication/installation drawings, layouts, sections, coordination
- "Sample"         — physical samples, selection samples, verification samples
- "Certification"  — mfr certificates, qualification statements, signed design data
- "Warranty"       — executed warranty, specimen warranty
- "O&M Manual"     — maintenance data, cleaning procedures, test schedules
- "Lab Test"       — test reports, evaluation reports (ICC-ES), preconstruction/field tests
- "Attic Stock"    — extra/spare materials for owner
- "Other"          — schedules, MSDS-as-misc, anything not fitting above

==== WHAT COUNTS AS A SUBMITTAL ====
- Each lettered item (A, B, C…) under a SUBMITTALS, ACTION SUBMITTALS, INFORMATIONAL
  SUBMITTALS, or CLOSEOUT SUBMITTALS article is ONE submittal row.
- Skip non-submittal headers that appear inline (e.g. "QUALITY ASSURANCE",
  "DELIVERY, STORAGE AND HANDLING", "PROJECT CONDITIONS", "WARRANTY" as a section
  about warranty terms rather than a submitted document). These are NOT submittals.
- INFORMATIONAL SUBMITTALS and CLOSEOUT SUBMITTALS articles DO count — include them.

==== SUB-ITEM CONDENSING (sub_bullets) ====
- If a lettered item has numbered sub-items (1, 2, 3 or a, b, c), capture them as
  a list of short condensed strings using construction abbreviations:
  mfr's, dims, req's, install, BMS, fab, accys, ops, etc.
- Each sub-bullet is one short comma-separated phrase
  (e.g. "materials, finishes, fab details, dims").
- If the item has no sub-items, return an empty array.

==== OUTPUT SCHEMA ====
Respond with ONLY compact JSON — no markdown, no prose:
{
  "submittals": [
    {
      "letter": "A",
      "type": "Product Data",
      "heading": "Product Data",
      "description": "Mfr's catalog pages, materials, finishes, fab details",
      "sub_bullets": ["materials, finishes, fab details, dims, profiles, mounting",
                      "styles, descriptions, components, accys, ops instructions"]
    }
  ]
}

If the section has no submittal items, return: {"submittals": []}
Keep "description" under 120 characters. One entry per lettered item.
"type" MUST be exactly one of the nine allowed values.`

// ─── Classification ──────────────────────────────────────────────────────────

const ALLOWED = new Set<string>(SUBMITTAL_TYPES)

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
    type: coerceType(o.type),
    heading: heading || description,
    description: description || heading,
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
  } catch {
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
