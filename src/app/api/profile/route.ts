import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

// Per-user profile fields the user may edit about THEMSELVES.
//
// Today this is just full_name (appears as "Reviewed By" on the submittal review
// stamp). The write deliberately goes through the SERVICE-ROLE client rather than
// the user's RLS-bound client: it lets us update the caller's own row while
// hard-allow-listing EXACTLY full_name in code, so role / company_id / user_id
// can never be reached through this route. We add NO new RLS policy on
// user_profiles (an UPDATE policy would re-expose role to self-escalation).

const MAX_LEN = 120

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: profile } = await supabase
    .from("user_profiles").select("full_name").eq("user_id", user.id).maybeSingle()

  return NextResponse.json({ full_name: profile?.full_name ?? null })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const raw = body && typeof body.full_name === "string" ? body.full_name : null
  if (raw === null) {
    return NextResponse.json({ error: "full_name is required" }, { status: 400 })
  }
  const full_name = raw.trim()
  if (!full_name) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
  }
  if (full_name.length > MAX_LEN) {
    return NextResponse.json({ error: `Name must be ${MAX_LEN} characters or fewer` }, { status: 400 })
  }

  // Service client bypasses RLS; scope the write to the caller's OWN row and pass
  // ONLY full_name. role / company_id / user_id are untouchable here.
  //
  // We .select() the affected rows and treat ZERO matches as a hard 404 — NOT a
  // silent success. A regular (cookie) client write to user_profiles returns 0
  // rows with no error by RLS design; even on this admin client, 0 rows means the
  // caller's profile row genuinely does not exist yet (e.g. invite-accept hasn't
  // committed it). Callers that race row creation must see this and retry rather
  // than believe the name was saved.
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("user_profiles")
    .update({ full_name })
    .eq("user_id", user.id)
    .select("user_id")

  if (error) {
    console.error("[api/profile] full_name update failed", error)
    return NextResponse.json({ error: "Could not save name", updated: 0 }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Profile not found", updated: 0 }, { status: 404 })
  }

  return NextResponse.json({ full_name, updated: data.length })
}
