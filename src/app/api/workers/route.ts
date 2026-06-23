import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Manpower Phase 2 — Workers roster API (workers table only; migration 0021 is
// already live in prod). Standard cookie-based server client per the existing
// route convention — NOT the in-review bearer createClientFromRequest (PR #39).
// RLS scopes every read/write to the caller's company; company_id is set by the
// DB default get_my_company_id() on INSERT and is NEVER accepted from the client.

interface WorkerInput {
  full_name?: unknown
  trade?: unknown
  phone?: unknown
  email?: unknown
  notes?: unknown
  active?: unknown
}

// Optional free-text field → trimmed string or null (blank collapses to null).
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// Build a validated INSERT row from raw client input. Returns an error string if
// full_name is missing. company_id is intentionally omitted — the DB default
// fills it from get_my_company_id(); created_by likewise rides its DB default
// (mirrors the projects insert, which sets neither).
function toInsertRow(input: WorkerInput): { row: Record<string, unknown> } | { error: string } {
  const full_name = typeof input.full_name === "string" ? input.full_name.trim() : ""
  if (!full_name) return { error: "Full name is required" }
  const row: Record<string, unknown> = {
    full_name,
    trade: strOrNull(input.trade),
    phone: strOrNull(input.phone),
    email: strOrNull(input.email),
    notes: strOrNull(input.notes),
  }
  // active defaults true in the DB; only override when the client sends a boolean.
  if (typeof input.active === "boolean") row.active = input.active
  return { row }
}

const SELECT_COLS = "id, full_name, trade, phone, email, active, notes, created_at"

// GET /api/workers — the company roster. RLS-scoped (company_id =
// get_my_company_id() AND deleted_at IS NULL), so soft-deleted workers never
// surface here. Returns BOTH active and inactive workers: `active` is a roster
// attribute toggled in the list, not a soft-delete, so inactive rows must stay
// visible (otherwise toggling someone off would make them vanish with no way
// back). Ordered by name for a stable roster.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("workers")
    .select(SELECT_COLS)
    .order("full_name", { ascending: true })

  if (error) {
    console.error("Failed to load workers:", error)
    return NextResponse.json({ error: "Failed to load workers" }, { status: 500 })
  }
  return NextResponse.json({ workers: data ?? [] })
}

// POST /api/workers — create worker(s). Two shapes:
//   • single: { full_name, trade?, phone?, email?, notes?, active? } → { worker }
//   • bulk:   { workers: [ { full_name, trade? }, ... ] }            → { workers }
// The bulk shape backs the roster's paste-a-list flow. Every row is validated
// (full_name required) and stripped to the allow-list before a single atomic
// INSERT, so company_id/created_by always come from DB defaults — the client can
// never set them. Bulk is capped to keep one paste from inserting unbounded rows.
const BULK_MAX = 500

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  // ── Bulk shape ────────────────────────────────────────────────────────────
  if (Array.isArray((body as { workers?: unknown }).workers)) {
    const inputs = (body as { workers: WorkerInput[] }).workers
    if (inputs.length === 0) {
      return NextResponse.json({ error: "No workers to add" }, { status: 400 })
    }
    if (inputs.length > BULK_MAX) {
      return NextResponse.json({ error: `Too many workers (max ${BULK_MAX} per batch)` }, { status: 400 })
    }
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < inputs.length; i++) {
      const built = toInsertRow(inputs[i] ?? {})
      if ("error" in built) {
        return NextResponse.json({ error: `Row ${i + 1}: ${built.error}` }, { status: 400 })
      }
      rows.push(built.row)
    }
    const { data, error } = await supabase.from("workers").insert(rows).select(SELECT_COLS)
    if (error) {
      console.error("Failed to bulk-create workers:", error)
      return NextResponse.json({ error: "Failed to add workers" }, { status: 500 })
    }
    return NextResponse.json({ workers: data ?? [] }, { status: 201 })
  }

  // ── Single shape ──────────────────────────────────────────────────────────
  const built = toInsertRow(body as WorkerInput)
  if ("error" in built) {
    return NextResponse.json({ error: built.error }, { status: 400 })
  }
  const { data, error } = await supabase.from("workers").insert(built.row).select(SELECT_COLS).single()
  if (error) {
    console.error("Failed to create worker:", error)
    return NextResponse.json({ error: "Failed to create worker" }, { status: 500 })
  }
  return NextResponse.json({ worker: data }, { status: 201 })
}
