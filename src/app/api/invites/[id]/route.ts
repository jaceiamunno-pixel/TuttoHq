import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Phase 3 — invite revocation. Admin-only. Soft-delete: status → 'revoked'
// (keeps the audit trail of who-invited-whom-when). We always return ok:true
// on a successful UPDATE call, even if zero rows matched (wrong id, wrong
// company, already accepted/revoked) — this avoids leaking the existence of
// invite ids in other companies. RLS already scopes UPDATE to our company.

export async function DELETE(
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

  const { error } = await supabase
    .from("company_invites")
    .update({ status: "revoked" })
    .eq("id", id)
    .eq("status", "pending")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
