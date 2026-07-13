import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Equipment Inventory — catalog API (ADR-018; tables live via migration 0040).
// Standard cookie-based server client per the workers/projects convention. RLS
// scopes every read/write to the caller's company; company_id is set by the DB
// default get_my_company_id() on INSERT and is NEVER accepted from the client.
//
// Counts (owned / checked_out / available) come ONLY from the equipment_availability
// VIEW — never recomputed here. The view is security_invoker, so its base-table
// RLS applies through it and it stays tenant-scoped.

// Optional free-text → trimmed string or null (blank collapses to null).
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// GET /api/equipment/items — the catalog with view-backed counts.
// Two RLS-scoped reads merged by item_id: the availability view (owned /
// checked_out / available) + the items table (description, which the view
// doesn't carry). The view already drops soft-deleted items, so it drives the
// list; description is grafted on where present.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [availRes, itemsRes] = await Promise.all([
    supabase
      .from("equipment_availability")
      .select("item_id, name, owned, checked_out, available")
      .order("name", { ascending: true }),
    supabase
      .from("equipment_items")
      .select("id, description")
      .is("deleted_at", null),
  ])

  if (availRes.error) {
    console.error("Failed to load equipment availability:", availRes.error)
    return NextResponse.json({ error: "Failed to load equipment" }, { status: 500 })
  }
  if (itemsRes.error) {
    console.error("Failed to load equipment items:", itemsRes.error)
    return NextResponse.json({ error: "Failed to load equipment" }, { status: 500 })
  }

  const descById = new Map<string, string | null>(
    (itemsRes.data ?? []).map(i => [i.id as string, (i.description as string | null) ?? null]),
  )
  const items = (availRes.data ?? []).map(a => ({
    item_id: a.item_id as string,
    name: a.name as string,
    description: descById.get(a.item_id as string) ?? null,
    owned: Number(a.owned) || 0,
    checked_out: Number(a.checked_out) || 0,
    available: Number(a.available) || 0,
  }))

  return NextResponse.json({ items })
}

// POST /api/equipment/items — create ONE catalog item plus N physical units.
// Body: { name, description?, quantity, serials? }. quantity is the number of
// unit rows to create (1 row per physical thing); serials is an optional array
// aligned to those units (serials[i] → unit i; blank/missing → null = counts
// mode). company_id / created_by ride their DB defaults on both inserts.
//
// Not a single DB transaction (no create-item-with-units RPC exists): the item
// is inserted first, then its units. If the units insert fails, the just-created
// item is soft-deleted (best effort) so the catalog isn't left with a phantom
// zero-unit row.
const QTY_MAX = 500

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 })

  const quantity = Number(body.quantity)
  if (!Number.isInteger(quantity) || quantity < 1) {
    return NextResponse.json({ error: "Quantity must be a whole number of 1 or more" }, { status: 400 })
  }
  if (quantity > QTY_MAX) {
    return NextResponse.json({ error: `Quantity too large (max ${QTY_MAX})` }, { status: 400 })
  }

  const serialsIn: unknown[] = Array.isArray(body.serials) ? body.serials : []

  // Create the catalog item (company_id/created_by from DB defaults).
  const { data: item, error: itemErr } = await supabase
    .from("equipment_items")
    .insert({ name, description: strOrNull(body.description) })
    .select("id, name, description, created_at")
    .single()

  if (itemErr || !item) {
    console.error("Failed to create equipment item:", itemErr)
    return NextResponse.json({ error: "Failed to create equipment" }, { status: 500 })
  }

  // One unit row per physical thing; serial optional per unit.
  const unitRows = Array.from({ length: quantity }, (_, i) => ({
    item_id: item.id as string,
    serial: strOrNull(serialsIn[i]),
  }))

  const { error: unitsErr } = await supabase.from("equipment_units").insert(unitRows)
  if (unitsErr) {
    console.error("Failed to create equipment units, rolling back item:", unitsErr)
    // Best-effort cleanup so we don't strand a zero-unit item in the catalog.
    await supabase.rpc("soft_delete_equipment_item", { p_id: item.id }).then(
      () => {},
      () => {},
    )
    // A duplicate serial within the company trips the partial unique index.
    if (unitsErr.code === "23505") {
      return NextResponse.json({ error: "One of those serials is already in use." }, { status: 409 })
    }
    return NextResponse.json({ error: "Failed to create equipment units" }, { status: 500 })
  }

  return NextResponse.json(
    {
      item: {
        item_id: item.id as string,
        name: item.name as string,
        description: (item.description as string | null) ?? null,
        owned: quantity,
        checked_out: 0,
        available: quantity,
      },
    },
    { status: 201 },
  )
}
