import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Manpower Phase 2 — single worker edit + soft-delete (workers table only).
// Standard cookie server client; RLS scopes every read/write to the caller's
// company. company_id is never re-resolved from the client on any path here.

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

const SELECT_COLS = "id, full_name, trade, phone, email, active, notes, created_at"

// PATCH /api/workers/[id] — edit a worker from an explicit allow-list only
// (full_name, trade, phone, email, active, notes). This is a plain UPDATE, which
// is safe for these fields: it never touches deleted_at, so the post-update row
// still satisfies the SELECT policy (deleted_at IS NULL). Soft-delete/restore go
// through the RPCs below — never a bare deleted_at UPDATE (that fails 42501
// against the deleted_at-IS-NULL policy; see ADR-007 / migration 0020).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const patch: Record<string, string | boolean | null> = {}
  if ("full_name" in body) {
    const v = typeof body.full_name === "string" ? body.full_name.trim() : ""
    if (!v) return NextResponse.json({ error: "Full name cannot be empty" }, { status: 400 })
    patch.full_name = v
  }
  if ("trade" in body) patch.trade = strOrNull(body.trade)
  if ("phone" in body) patch.phone = strOrNull(body.phone)
  if ("email" in body) patch.email = strOrNull(body.email)
  if ("notes" in body) patch.notes = strOrNull(body.notes)
  if ("active" in body && typeof body.active === "boolean") patch.active = body.active

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }

  // .select().maybeSingle() doubles as the tenant/existence check: RLS limits the
  // UPDATE to this company's live rows, so a cross-company or soft-deleted id
  // updates 0 rows and returns null → 404.
  const { data, error } = await supabase
    .from("workers")
    .update(patch)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle()

  if (error) {
    console.error("Failed to update worker:", error)
    return NextResponse.json({ error: "Failed to update worker" }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: "Worker not found" }, { status: 404 })
  return NextResponse.json({ worker: data })
}

// DELETE /api/workers/[id] — SOFT delete via the soft_delete_worker SECURITY
// DEFINER function (migration 0021), company-scoped internally via
// get_my_company_id(). NOT a bare UPDATE deleted_at: that would move the row out
// of the SELECT policy (deleted_at IS NULL) and be rejected 42501 — the
// established pattern is the RPC (ADR-007 / migration 0020). The fn returns the
// id on success, or no row if not found / cross-company / already deleted → 404.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data: deletedId, error } = await supabase.rpc("soft_delete_worker", { p_id: id })
  if (error) {
    console.error("Failed to soft-delete worker:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!deletedId) return NextResponse.json({ error: "Worker not found or already deleted" }, { status: 404 })
  return NextResponse.json({ ok: true, id })
}
