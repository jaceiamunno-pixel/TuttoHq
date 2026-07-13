import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Equipment Inventory — CHECK OUT a unit (ADR-018 / migration 0040).
//
// THE CAREFUL SEAM. A checkout is one INSERT into equipment_assignments with
// returned_at NULL (open). The database — NOT this code — enforces that a unit
// can be out in only one place at a time, via the partial unique index
// equipment_assignments_one_open_per_unit. This route:
//   • validates the polymorphic holder payload (exactly one holder field, matching
//     holder_type) so a malformed request fails fast with 400 rather than tripping
//     the DB CHECK,
//   • lets the DB be the source of truth for the one-open-per-unit invariant, and
//   • CATCHES the 23505 unique-violation (two people racing the same unit) and
//     surfaces it as a friendly 409 — it does NOT work around the index or swallow
//     it. The client refreshes the unit's status on 409.
//
// company_id / created_by / checked_out_at ride their DB defaults; never sent.

const HOLDER_TYPES = ["project", "person", "location"] as const
type HolderType = (typeof HOLDER_TYPES)[number]

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// A date-only "YYYY-MM-DD" (or null). Anything else is rejected — we never coerce
// a full timestamp into this soft, unenforced field.
function dateOnlyOrNull(v: unknown): string | null | undefined {
  if (v == null || v === "") return null
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  return undefined // signal "invalid"
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: unitId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const holder_type = (body as { holder_type?: unknown }).holder_type
  if (typeof holder_type !== "string" || !HOLDER_TYPES.includes(holder_type as HolderType)) {
    return NextResponse.json({ error: "Pick who this is checked out to." }, { status: 400 })
  }

  // Build the row with EXACTLY the one holder field that matches holder_type.
  // This mirrors the DB CHECK (equipment_assignment_holder_exclusive); validating
  // here turns a would-be 23514 into a clear 400.
  const row: Record<string, unknown> = { unit_id: unitId, holder_type }
  if (holder_type === "project") {
    const project_id = strOrNull((body as { project_id?: unknown }).project_id)
    if (!project_id) return NextResponse.json({ error: "Choose a project." }, { status: 400 })
    row.project_id = project_id
  } else if (holder_type === "person") {
    const worker_id = strOrNull((body as { worker_id?: unknown }).worker_id)
    if (!worker_id) return NextResponse.json({ error: "Choose a person." }, { status: 400 })
    row.worker_id = worker_id
  } else {
    const location_label = strOrNull((body as { location_label?: unknown }).location_label)
    if (!location_label) return NextResponse.json({ error: "Enter a location." }, { status: 400 })
    row.location_label = location_label
  }

  const expected = dateOnlyOrNull((body as { expected_return_date?: unknown }).expected_return_date)
  if (expected === undefined) {
    return NextResponse.json({ error: "Expected return date must be a valid date." }, { status: 400 })
  }
  if (expected) row.expected_return_date = expected

  const notes = strOrNull((body as { notes?: unknown }).notes)
  if (notes) row.notes = notes

  const { data, error } = await supabase
    .from("equipment_assignments")
    .insert(row)
    .select("id, holder_type, checked_out_at, expected_return_date")
    .single()

  if (error) {
    // 23505 = the one-open-per-unit index fired: someone already has this unit out
    // (or a race). The index is the source of truth; surface it, don't route around it.
    if (error.code === "23505") {
      return NextResponse.json({ error: "This unit is already checked out.", conflict: true }, { status: 409 })
    }
    // 23503 = FK violation → the chosen project/worker isn't in this company.
    if (error.code === "23503") {
      return NextResponse.json({ error: "That holder no longer exists." }, { status: 400 })
    }
    // 23514 = the holder CHECK constraint (backstop for anything validation missed).
    if (error.code === "23514") {
      return NextResponse.json({ error: "Invalid checkout details." }, { status: 400 })
    }
    console.error("Failed to check out equipment unit:", error)
    return NextResponse.json({ error: "Failed to check out unit" }, { status: 500 })
  }

  return NextResponse.json({ assignment: data }, { status: 201 })
}
