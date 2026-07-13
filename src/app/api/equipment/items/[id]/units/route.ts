import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Equipment Inventory — per-item unit list + add-unit (ADR-018 / migration 0040).
// RLS scopes everything to the caller's company. company_id rides the DB default
// on INSERT and is never accepted from the client.

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// A unit plus its current open assignment (if any). holder is resolved to a
// display name here so the client renders "Out — {holder}" without a second hop.
interface OpenAssignment {
  id: string
  holder_type: string
  holder_label: string
  checked_out_at: string
  expected_return_date: string | null
}

// GET /api/equipment/items/[id]/units — live units for one item, each with its
// open assignment resolved. Two RLS-scoped reads: the item's non-deleted units,
// then the OPEN (returned_at IS NULL), non-deleted assignments on those units,
// merged by unit_id. The one-open-per-unit invariant guarantees at most one open
// assignment per unit, so the merge is unambiguous.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: itemId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: units, error: unitsErr } = await supabase
    .from("equipment_units")
    .select("id, serial, created_at")
    .eq("item_id", itemId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })

  if (unitsErr) {
    console.error("Failed to load equipment units:", unitsErr)
    return NextResponse.json({ error: "Failed to load units" }, { status: 500 })
  }

  const unitIds = (units ?? []).map(u => u.id as string)
  const openByUnit = new Map<string, OpenAssignment>()

  if (unitIds.length > 0) {
    // Embed the holder's display name via the real FKs (projects / workers).
    const { data: assigns, error: assignErr } = await supabase
      .from("equipment_assignments")
      .select(
        "id, unit_id, holder_type, project_id, worker_id, location_label, checked_out_at, expected_return_date, projects(name), workers(full_name)",
      )
      .in("unit_id", unitIds)
      .is("returned_at", null)
      .is("deleted_at", null)

    if (assignErr) {
      console.error("Failed to load equipment assignments:", assignErr)
      return NextResponse.json({ error: "Failed to load units" }, { status: 500 })
    }

    for (const a of assigns ?? []) {
      // Supabase types to-one embeds as possibly-array; normalize.
      const project = Array.isArray(a.projects) ? a.projects[0] : a.projects
      const worker = Array.isArray(a.workers) ? a.workers[0] : a.workers
      const holder_label =
        a.holder_type === "project"
          ? (project?.name as string | undefined) ?? "Project"
          : a.holder_type === "person"
            ? (worker?.full_name as string | undefined) ?? "Worker"
            : (a.location_label as string | null) ?? "Location"
      openByUnit.set(a.unit_id as string, {
        id: a.id as string,
        holder_type: a.holder_type as string,
        holder_label,
        checked_out_at: a.checked_out_at as string,
        expected_return_date: (a.expected_return_date as string | null) ?? null,
      })
    }
  }

  const rows = (units ?? []).map(u => ({
    id: u.id as string,
    serial: (u.serial as string | null) ?? null,
    created_at: u.created_at as string,
    open_assignment: openByUnit.get(u.id as string) ?? null,
  }))

  return NextResponse.json({ units: rows })
}

// POST /api/equipment/items/[id]/units — add one physical unit to an item.
// Body: { serial? }. serial optional (null = counts mode). company_id rides the
// DB default. A duplicate serial within the company trips the partial unique
// index (23505) → 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: itemId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const serial = strOrNull((body as { serial?: unknown }).serial)

  const { data, error } = await supabase
    .from("equipment_units")
    .insert({ item_id: itemId, serial })
    .select("id, serial, created_at")
    .single()

  if (error) {
    console.error("Failed to add equipment unit:", error)
    if (error.code === "23505") {
      return NextResponse.json({ error: "That serial is already in use." }, { status: 409 })
    }
    // FK violation → the item id doesn't belong to this company (or doesn't exist).
    if (error.code === "23503") {
      return NextResponse.json({ error: "Equipment item not found." }, { status: 404 })
    }
    return NextResponse.json({ error: "Failed to add unit" }, { status: 500 })
  }

  return NextResponse.json(
    { unit: { id: data.id as string, serial: (data.serial as string | null) ?? null, created_at: data.created_at as string, open_assignment: null } },
    { status: 201 },
  )
}
