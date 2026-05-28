import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

// Phase 3 — account members + pending invites for the admin Team tab.
// Admin-only. The admin (service-role) client is needed to:
//   1. Read user_profiles rows for OTHER users in the company (the
//      SELECT-own RLS policy hides them from the cookie client).
//   2. Look up auth.users for email + full_name (auth schema is not
//      exposed to PostgREST).
//
// company_id is ALWAYS derived from the CALLER'S SESSION via user_profiles
// (which the cookie client can read for own row only). Never trust a
// client-supplied company id.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const { data: myProfile } = await supabase
    .from("user_profiles").select("company_id").maybeSingle()
  if (!myProfile?.company_id) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }
  const companyId = myProfile.company_id

  const admin = createAdminClient()

  const { data: profileRows, error: profErr } = await admin
    .from("user_profiles")
    .select("user_id, role, created_at")
    .eq("company_id", companyId)
  if (profErr) {
    return NextResponse.json({ error: profErr.message }, { status: 500 })
  }

  // Per-user getUserById — typical companies are 5–25 users. Trivial to
  // switch to listUsers + filter if companies ever grow into the thousands.
  const members = await Promise.all(
    (profileRows ?? []).map(async (p) => {
      const { data: userData } = await admin.auth.admin.getUserById(p.user_id)
      const u = userData?.user
      return {
        user_id:   p.user_id,
        email:     u?.email ?? null,
        full_name: (u?.user_metadata?.full_name as string | undefined) ?? null,
        role:      p.role,
        joined_at: p.created_at,
        is_self:   p.user_id === user.id,
      }
    }),
  )

  // Pending invites via the cookie client — RLS already scopes to the
  // caller's company via the "company_invites: company select" policy.
  // We include the token so the client can render a "Copy link" button per
  // row; the URL is composed here (same baseUrl logic as POST /api/invites)
  // so the client never reconstructs it. Exposing the token to the admin
  // who's already managing these invites is not a widening — they could
  // re-derive it from the most-recent invite banner anyway.
  const { data: pending } = await supabase
    .from("company_invites")
    .select("id, email, role, token, expires_at, created_at")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin).replace(/\/$/, "")
  const pendingWithUrl = (pending ?? []).map(inv => ({
    id:         inv.id,
    email:      inv.email,
    role:       inv.role,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
    invite_url: `${baseUrl}/invite/${inv.token}`,
  }))

  return NextResponse.json({
    members,
    pending_invites: pendingWithUrl,
  })
}
