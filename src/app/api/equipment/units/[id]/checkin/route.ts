import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Equipment Inventory — CHECK IN a unit (ADR-018 / migration 0040).
//
// Close the unit's open assignment: UPDATE its returned_at = now(). That frees
// the unit — the availability view recomputes `available` from the base tables,
// so we NEVER touch a counter by hand. Scoped by unit_id + returned_at IS NULL
// (RLS adds the company scope). The equipment_assignments SELECT policy is
// company_id-only (no deleted_at), so this UPDATE ... RETURNING is not subject to
// the 42501 RETURNING trap.
//
// The one-open-per-unit invariant guarantees at most one matching row, so the
// filtered UPDATE closes exactly the open assignment. 0 rows matched → the unit
// wasn't checked out (already returned / raced) → 409.

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: unitId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("equipment_assignments")
    .update({ returned_at: new Date().toISOString() })
    .eq("unit_id", unitId)
    .is("returned_at", null)
    .is("deleted_at", null)
    .select("id, returned_at")

  if (error) {
    console.error("Failed to check in equipment unit:", error)
    return NextResponse.json({ error: "Failed to check in unit" }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "This unit isn't checked out." }, { status: 409 })
  }

  return NextResponse.json({ ok: true, assignment: data[0] })
}
