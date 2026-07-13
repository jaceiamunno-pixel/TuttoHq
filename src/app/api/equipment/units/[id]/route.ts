import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Equipment Inventory — single-unit edit + retire (ADR-018 / migration 0040).
// RLS scopes reads/writes to the caller's company. Retire is SOFT-delete only,
// through the SECURITY DEFINER RPC (there is NO permissive DELETE policy — a bare
// DELETE is denied for everyone).

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// PATCH /api/equipment/units/[id] — edit a unit's serial (go-fast). A plain
// RLS-scoped UPDATE: the equipment_units SELECT policy is company_id-only (no
// deleted_at), so the UPDATE ... RETURNING is not subject to the 42501 trap.
// A cross-company / soft-deleted id matches 0 rows → 404. Duplicate serial → 409.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || !("serial" in body)) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("equipment_units")
    .update({ serial: strOrNull((body as { serial?: unknown }).serial) })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, serial, created_at")
    .single()

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "That serial is already in use." }, { status: 409 })
    }
    // .single() with 0 rows → PGRST116; treat as not-found.
    if (error.code === "PGRST116") {
      return NextResponse.json({ error: "Unit not found" }, { status: 404 })
    }
    console.error("Failed to update equipment unit:", error)
    return NextResponse.json({ error: "Failed to update unit" }, { status: 500 })
  }

  return NextResponse.json({ unit: { id: data.id as string, serial: (data.serial as string | null) ?? null, created_at: data.created_at as string } })
}

// DELETE /api/equipment/units/[id] — retire a unit (soft-delete via RPC).
// The RPC is company-scoped internally (get_my_company_id()) and returns the id
// it deleted, or null if nothing matched (wrong company / already deleted) → 404.
// Retiring a unit does not auto-return its open assignment; the availability
// view drops a deleted unit from both owned and checked_out, so counts stay sound.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase.rpc("soft_delete_equipment_unit", { p_id: id })

  if (error) {
    console.error("Failed to retire equipment unit:", error)
    return NextResponse.json({ error: "Failed to retire unit" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: "Unit not found" }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
