import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Restore a soft-deleted project (ADR-007 step 2). Admin-only: clears deleted_at
// so the project reappears across every company read. The project id comes from
// the admin recycle-bin view (ADR-007 step 3, not yet built).
//
// Restore goes through the restore_project SECURITY DEFINER function (migration
// 0020), company-scoped via get_my_company_id(). This keeps EVERY deleted_at write
// on projects funneled through the definer functions: the soft-delete path MUST use
// one — a bare authed UPDATE stamping deleted_at is rejected because the resulting
// row fails the SELECT policy (deleted_at IS NULL) that applies to the authenticated
// role ("new row violates row-level security policy") — and restore rides the same
// mechanism for symmetry. The function (run as its owner, bypassing RLS) returns the
// id on success, or no row if not found / cross-company / not currently deleted.
// The admin role is asserted here in-route and never trusted from the client.
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

  const { data: restoredId, error } = await supabase.rpc("restore_project", { p_id: id })
  if (error) {
    console.error("Failed to restore project:", error)
    return NextResponse.json({ error: "Failed to restore project" }, { status: 500 })
  }
  if (!restoredId) {
    // No row returned: id not found, not in caller's company, or not currently deleted.
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  return NextResponse.json({ ok: true, id: restoredId })
}
