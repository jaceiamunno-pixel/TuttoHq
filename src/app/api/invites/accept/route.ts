import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

// Phase 4 — atomic accept flow.
//
// This route is PUBLIC (added to middleware PUBLIC_PATHS). With email
// confirmation ON at the Supabase project level, an invitee has no session
// after auth.signUp — they're an unconfirmed auth user. The TOKEN is the
// security boundary, not a session.
//
// The accept_invite_link SQL function does the entire accept in one
// transaction: validate token, look up the just-signed-up auth user by
// invite.email, run all gates (banned/deleted, email_confirmed_at IS NULL,
// created_at >= invite.created_at, no existing user_profiles), and on
// success link user_profiles + set email_confirmed_at + mark invite
// accepted. REVOKEd from PUBLIC/anon/authenticated and GRANTed only to
// service_role, so this route's admin client is the only legitimate caller.

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = typeof body.token === "string" ? body.token : ""
  if (!token) {
    return NextResponse.json({ error: "Token required" }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin.rpc("accept_invite_link", { p_token: token })
  if (error) {
    console.error("[invites/accept] RPC error", error)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }

  const result = (data ?? [])[0] as { success: boolean; error_code: string | null } | undefined
  if (!result?.success) {
    const code = result?.error_code ?? "unknown"
    const map: Record<string, { msg: string; status: number }> = {
      not_found:                { msg: "Invalid invite link",                                                       status: 404 },
      accepted:                 { msg: "This invite was already used. Please sign in instead.",                     status: 410 },
      revoked:                  { msg: "This invite was revoked. Contact the admin for a new one.",                 status: 410 },
      expired:                  { msg: "This invite has expired. Ask the admin for a new one.",                     status: 410 },
      no_signup:                { msg: "We couldn't find your account. Sign up using this invite first.",          status: 400 },
      account_unavailable:      { msg: "This account is unavailable. Contact the admin.",                           status: 410 },
      pre_existing_confirmed:   { msg: "An account with this email already exists. Sign in instead.",               status: 409 },
      pre_existing_unconfirmed: { msg: "An older unconfirmed account exists for this email. Contact the admin.",    status: 409 },
      already_linked:           { msg: "This account is already linked to a company.",                              status: 409 },
    }
    const m = map[code] ?? { msg: "Could not accept invitation", status: 500 }
    return NextResponse.json({ error: m.msg }, { status: m.status })
  }

  return NextResponse.json({ ok: true })
}
