import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Restore a soft-deleted project (ADR-007 step 2). Admin-only: clears
// deleted_at so the project reappears across every company read. The project id
// comes from the admin recycle-bin view (ADR-007 step 3, not yet built).
//
// We do NOT pre-fetch the row: under the migration-0015 SELECT policy a
// soft-deleted project (deleted_at IS NOT NULL) is invisible to a normal read,
// so a verifying SELECT would always 404. Instead we UPDATE ... RETURNING,
// which is gated by the UPDATE policy (company-scoped, unchanged by 0015), not
// the SELECT policy — so a cross-company id matches no row, and the returned
// row (deleted_at now NULL) confirms the restore. Tenant isolation is enforced
// by that company-scoped UPDATE policy; the admin role is asserted here in-route
// and never trusted from the client.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const { id } = await params

  const { data, error } = await supabase
    .from("projects")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("id, name, number, location, gc_name, architect, created_at, base_contract_value")
    .single()

  if (error) {
    // PGRST116 = zero rows returned: id not found, or not in caller's company
    // (filtered out by the company-scoped UPDATE policy).
    if (error.code === "PGRST116") {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    console.error("Failed to restore project:", error)
    return NextResponse.json({ error: "Failed to restore project" }, { status: 500 })
  }

  return NextResponse.json({ project: data })
}
