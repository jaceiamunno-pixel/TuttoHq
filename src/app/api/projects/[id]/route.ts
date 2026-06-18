import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json()

  const { name, number, location, gc_name, architect, base_contract_value } = body

  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
  }

  // base_contract_value: accept a number, a numeric string, or null/"" (clears it).
  // Anything non-numeric is rejected rather than silently coerced.
  let baseContract: number | null | undefined
  if (base_contract_value !== undefined) {
    if (base_contract_value === null || base_contract_value === "") {
      baseContract = null
    } else {
      const n = Number(base_contract_value)
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "base_contract_value must be a non-negative number" }, { status: 400 })
      }
      baseContract = n
    }
  }

  const updates: Record<string, string | number | null> = {}
  if (name !== undefined) updates.name = name.trim()
  if (number !== undefined) updates.number = number?.trim() ?? null
  if (location !== undefined) updates.location = location?.trim() ?? null
  if (gc_name !== undefined) updates.gc_name = gc_name?.trim() ?? null
  if (architect !== undefined) updates.architect = architect?.trim() ?? null
  if (baseContract !== undefined) updates.base_contract_value = baseContract

  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", id)
    .select("id, name, number, location, gc_name, architect, created_at, base_contract_value")
    .single()

  if (error) {
    console.error("Failed to update project:", error)
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 })
  }

  return NextResponse.json({ project: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Soft-delete (ADR-007): stamp deleted_at instead of a hard DELETE. The raw
  // DELETE policy on projects was dropped in migration 0015, so a real DELETE
  // would now silently fail. The old hard delete also cascaded across the child
  // tables — which, with no FKs to projects, is exactly how the hard-delete
  // incident orphaned/destroyed data. Children are intentionally left in place:
  // the RLS SELECT filter (deleted_at IS NULL) hides them via the now-hidden
  // parent across every picker. Destroying children is the separate admin-only
  // purge_project RPC (ADR-007 step 4), not this path.

  // RLS-scoped ownership check. Pull created_by for the role/ownership gate.
  // A live project (deleted_at IS NULL) still passes the SELECT filter, so this
  // read succeeds for anything deletable from the UI.
  const { data: project, error: selErr } = await supabase
    .from("projects").select("id, created_by").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Only the project's creator or a company admin may delete — unchanged from
  // the hard-delete path. RLS scopes to company; this is the role/ownership
  // gate on top. (Soft-delete is reversible, so this stays a delete-grade gate,
  // not the stricter admin-only gate that restore/purge use.)
  const { data: role } = await supabase.rpc("get_my_role")
  const isCreator = project.created_by === user.id
  const isAdmin   = role === "admin"
  if (!isCreator && !isAdmin) {
    return NextResponse.json(
      { error: "Only the project creator or an admin can delete this project" },
      { status: 403 },
    )
  }

  // Soft-delete via the soft_delete_project SECURITY DEFINER function (migration
  // 0020). A bare authed UPDATE stamping deleted_at is REJECTED: the resulting row
  // fails the SELECT policy (deleted_at IS NULL) that applies to the authenticated
  // role, so the write 403s ("new row violates row-level security policy") — which
  // is why projects soft-delete was broken in prod. The function runs as its owner
  // (bypasses RLS) and is company-scoped via get_my_company_id(); it returns the id
  // on success, or no row if not found / cross-company / already deleted.
  const { data: deletedId, error } = await supabase.rpc("soft_delete_project", { p_id: id })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!deletedId) return NextResponse.json({ error: "Not found" }, { status: 404 })

  return NextResponse.json({ ok: true })
}
