import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Equipment Inventory — item-level (catalog entry) delete (ADR-018 / migration 0040).
// SOFT-delete only, through the SECURITY DEFINER RPC (there is NO permissive DELETE
// policy — a bare DELETE is denied for everyone). The RPC is company-scoped
// internally via get_my_company_id().
//
// DELETE /api/equipment/items/[id] — retire an item (and, implicitly, all its units).
// Guard first: an item with units still checked out cannot be deleted. checked_out
// comes ONLY from the equipment_availability VIEW (RLS-scoped via security_invoker),
// never recomputed here. The view already GROUP BYs one row per live item, so a
// live item always has a row (checked_out ≥ 0); a wrong-company / already-deleted
// item has NO row → we fall through to the RPC, which returns null → 404.
//
// Deleting the item is enough on its own: the view filters `WHERE i.deleted_at IS
// NULL` at the item level, so soft-deleting the item drops the whole row — item AND
// all its units — from the availability counts. The unit rows are NOT separately
// touched this pass (they'd resurface only if the item were restored, which is the
// intended behavior).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Block the delete while any unit is out. maybeSingle(): a live item always has a
  // view row; null (no row) means wrong company / already deleted → let the RPC 404.
  const { data: avail, error: availErr } = await supabase
    .from("equipment_availability")
    .select("checked_out")
    .eq("item_id", id)
    .maybeSingle()

  if (availErr) {
    console.error("Failed to check equipment availability before delete:", availErr)
    return NextResponse.json({ error: "Failed to delete equipment" }, { status: 500 })
  }
  if (avail && (Number(avail.checked_out) || 0) > 0) {
    return NextResponse.json({ error: "Check in all units before deleting this item." }, { status: 409 })
  }

  const { data, error } = await supabase.rpc("soft_delete_equipment_item", { p_id: id })

  if (error) {
    console.error("Failed to delete equipment item:", error)
    return NextResponse.json({ error: "Failed to delete equipment" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
