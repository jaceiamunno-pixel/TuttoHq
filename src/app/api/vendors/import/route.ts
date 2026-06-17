import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const maxDuration = 60

// Self-serve spreadsheet import for the unified vendors master. The client
// parses the CSV/XLSX and column-maps it; this route receives already-mapped
// rows and commits them with three hard guarantees:
//
//   1. TENANT ISOLATION. No company_id is ever read from the request. Every
//      inserted row gets company_id from the column DEFAULT (get_my_company_id())
//      and is re-checked by the vendors RLS WITH CHECK. The dedup SELECT is also
//      RLS-scoped, so a caller can only ever see / collide with their own
//      company's vendors — never another tenant's.
//   2. DEDUP = SKIP. Key is the case-insensitive, trimmed company_name. A row
//      whose normalized name already exists in this company (or earlier in the
//      same batch) is skipped, not updated.
//   3. UNTYPED ON IMPORT. is_subcontractor and is_supplier are forced false; the
//      user tags vendors afterward in the directory UI (confirmed product call).

const TEXT_FIELDS = [
  "vendor_no", "trade", "specialty", "contact_name", "phone", "email",
  "street_address", "city", "state", "zip_code", "license_number", "website", "notes",
] as const

type ImportRow = Record<string, unknown>

const MAX_ROWS = 10000
const CHUNK = 500

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const rows: ImportRow[] = body.rows
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 })
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS})` }, { status: 400 })
  }

  // Existing company-scoped names (RLS confines this to the caller's company).
  // Paginated so dedup is complete even if PostgREST's max-rows caps a single
  // response below the company's vendor count — otherwise unseen rows could let
  // duplicates slip through.
  const seen = new Set<string>()
  const PAGE = 1000
  for (let from = 0; from < 200000; from += PAGE) {
    const { data: existing, error: existErr } = await supabase
      .from("vendors").select("company_name").range(from, from + PAGE - 1)
    if (existErr) return NextResponse.json({ error: existErr.message }, { status: 500 })
    for (const v of existing ?? []) seen.add((v.company_name ?? "").trim().toLowerCase())
    if (!existing || existing.length < PAGE) break
  }

  const toInsert: Record<string, unknown>[] = []
  const skippedNames: string[] = []
  let invalid = 0

  for (const raw of rows) {
    const company_name = cleanText(raw.company_name)
    if (!company_name) { invalid++; continue }           // no name → can't import
    const key = company_name.toLowerCase()
    if (seen.has(key)) { skippedNames.push(company_name); continue } // dupe → skip
    seen.add(key)                                         // also dedupes within the batch

    const row: Record<string, unknown> = {
      company_name,
      is_subcontractor: false,
      is_supplier: false,
      uploaded_by: user.id,
      // company_id intentionally omitted — DB default + RLS WITH CHECK own it.
    }
    for (const f of TEXT_FIELDS) row[f] = cleanText(raw[f])
    toInsert.push(row)
  }

  let inserted = 0
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK)
    const { data, error } = await supabase.from("vendors").insert(chunk).select("id")
    if (error) {
      // Partial progress is reported so the user knows what landed before the
      // failure rather than silently losing the count.
      return NextResponse.json(
        { error: error.message, inserted, skipped: skippedNames.length, invalid },
        { status: 500 },
      )
    }
    inserted += data?.length ?? 0
  }

  return NextResponse.json({
    inserted,
    skipped: skippedNames.length,
    skippedNames,
    invalid,
  })
}
