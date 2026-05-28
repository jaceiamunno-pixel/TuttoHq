import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getValidToken } from "@/lib/gmail"
import { sendGmailMessage } from "@/lib/gmail-send"
import crypto from "crypto"

// Phase 3 — invite generation. Admin-only. Sends the invite via the admin's
// connected Gmail; falls back to returning the copy-paste URL if Gmail isn't
// connected or send fails. The invite row is created BEFORE the email attempt
// so a Gmail failure never costs the admin the invite.

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  const inviteRole: "admin" | "member" | null =
    body.role === "admin" || body.role === "member" ? body.role : null

  if (!email || !EMAIL_RX.test(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 })
  }
  if (!inviteRole) {
    return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 })
  }

  // company_id derived from the caller's session via the SELECT-own RLS
  // policy on user_profiles. Never trust a client-supplied company id.
  const { data: profile } = await supabase
    .from("user_profiles").select("company_id").maybeSingle()
  if (!profile?.company_id) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }
  const companyId = profile.company_id

  // 32 random bytes → ~43-char URL-safe base64 (~256 bits of entropy).
  const token = crypto.randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: inserted, error: insErr } = await supabase
    .from("company_invites")
    .insert({
      company_id: companyId,
      email,
      role: inviteRole,
      token,
      invited_by: user.id,
      expires_at: expiresAt,
    })
    .select("id")
    .single()

  if (insErr) {
    // idx_company_invites_pending_unique — one pending invite per (company, email)
    if (insErr.code === "23505") {
      return NextResponse.json(
        { error: "An active invite for this email already exists. Revoke it first." },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  // Build the invite URL. Strip a trailing slash to avoid `//invite/...`.
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin).replace(/\/$/, "")
  const inviteUrl = `${baseUrl}/invite/${token}`

  // Company name + inviter name for the email body. Cheap RLS-scoped reads.
  let companyName = "your team"
  const { data: company } = await supabase
    .from("companies").select("name").eq("id", companyId).maybeSingle()
  if (company?.name) companyName = company.name

  const inviterName =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? "Someone"

  const subject  = `You've been invited to ${companyName} on TuttoHQ`
  const bodyText = `${inviterName} has invited you to join ${companyName} on TuttoHQ.

Accept your invitation (expires in 7 days):
${inviteUrl}

If you didn't expect this email, you can safely ignore it.`

  // Gmail failure (no connection, revoked token, transport error) must NOT
  // fail the request — the invite row is already 'pending'. We return the
  // URL so the admin can copy-paste it to the invitee out-of-band.
  let gmailSent = false
  try {
    const accessToken = await getValidToken(supabase, user.id)
    await sendGmailMessage(accessToken, { to: email, subject, bodyText })
    gmailSent = true
  } catch (err) {
    console.error("[invites] Gmail send failed; returning copy-paste link", err)
  }

  return NextResponse.json({
    id: inserted.id,
    invite_url: inviteUrl,
    gmail_sent: gmailSent,
  })
}
