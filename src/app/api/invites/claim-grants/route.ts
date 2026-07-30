import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseGrants } from "@/lib/field-access-shared"

// ADR-020 — materialize a field invite's project_grants into project_access.
//
// WHY A SEPARATE ROUTE: accept_invite_link (SECURITY DEFINER, service-role
// only) creates the user_profiles row but returns no user id, and this phase
// touches no SQL. So the accept form calls this route right after
// signInWithPassword: the SESSION identifies the accepting user, and the
// SERVICE-ROLE client (the same trusted path the accept route uses) performs
// the project_access writes that the admin-only RLS would block for the
// (non-admin) accepting user.
//
// Trust chain, in order:
//   1. Session required — user identity comes from auth, not the payload.
//   2. Invite looked up by TOKEN (unguessable, 256-bit) via service role;
//      must be status='accepted' and role='field'.
//   3. The invite's email must equal the session user's email
//      (case-insensitive) — the claim is bound to the invitee, not just to
//      anyone holding the token.
//   4. The session user's user_profiles row must exist with company_id equal
//      to the invite's company_id and role='field' — i.e. this user IS the
//      profile accept_invite_link just linked for this invite. A stranger who
//      somehow obtained the token gains nothing: their profile (if any) is in
//      another company, or absent.
//   5. Each grant's project must belong to the invite's company; anything
//      else is skipped and logged (the invite route validates at creation,
//      so skips here mean the project was deleted in between).
//
// SINGLE-USE: after the project_access upsert succeeds, project_grants is
// nulled on the invite — the token must not remain a replayable
// grant-restore primitive after admin revocations. Manage access (Settings →
// Team) is the sole grant authority post-claim. A re-call with a null
// payload returns ok as a no-op.
//
// Idempotent up to that consumption: upsert on the (user_id, project_id,
// module) unique key, and a failed upsert leaves project_grants intact so
// the client's bounded retry can re-run the claim.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const token = typeof body.token === "string" ? body.token : ""
  if (!token) return NextResponse.json({ error: "Token required" }, { status: 400 })

  const admin = createAdminClient()

  const { data: invite, error: invErr } = await admin
    .from("company_invites")
    .select("id, company_id, email, role, status, invited_by, project_grants")
    .eq("token", token)
    .maybeSingle()
  if (invErr) {
    console.error("[claim-grants] invite lookup failed", invErr)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
  if (!invite) return NextResponse.json({ error: "Invalid invite" }, { status: 404 })
  if (invite.status !== "accepted") {
    return NextResponse.json({ error: "Invite not accepted yet" }, { status: 409 })
  }
  if (invite.role !== "field") {
    // Nothing to materialize for admin/member invites.
    return NextResponse.json({ ok: true, granted: 0, skipped: 0 })
  }

  // Bind the claim to the INVITEE: the session user's email must match the
  // invite's email (case-insensitive) — mirrors accept_invite_link's own
  // auth-user lookup by lower(email).
  if (!user.email || user.email.toLowerCase() !== String(invite.email ?? "").toLowerCase()) {
    return NextResponse.json({ error: "Not the invited user" }, { status: 403 })
  }

  // Bind the session user to the profile accept_invite_link created for THIS
  // invite: same company, field role.
  const { data: profile } = await admin
    .from("user_profiles")
    .select("company_id, role")
    .eq("user_id", user.id)
    .maybeSingle()
  if (!profile || profile.company_id !== invite.company_id || profile.role !== "field") {
    return NextResponse.json({ error: "Not the invited user" }, { status: 403 })
  }

  const { grants, invalid } = parseGrants(invite.project_grants)
  if (invalid > 0) {
    console.warn(`[claim-grants] invite ${invite.id}: ${invalid} malformed grant(s) skipped`)
  }
  if (grants.length === 0) {
    console.warn(`[claim-grants] field invite ${invite.id} has no usable grants`)
    return NextResponse.json({ ok: true, granted: 0, skipped: invalid })
  }

  // Re-validate project ownership against the invite's company (a project may
  // have been deleted between invite and accept). Skip + log mismatches.
  const projectIds = [...new Set(grants.map(g => g.project_id))]
  const { data: owned } = await admin
    .from("projects")
    .select("id")
    .eq("company_id", invite.company_id)
    .in("id", projectIds)
  const ownedIds = new Set((owned ?? []).map(p => p.id))
  const usable = grants.filter(g => ownedIds.has(g.project_id))
  const skipped = grants.length - usable.length + invalid
  for (const g of grants) {
    if (!ownedIds.has(g.project_id)) {
      console.warn(`[claim-grants] invite ${invite.id}: project ${g.project_id} not in company ${invite.company_id} — skipped`)
    }
  }

  if (usable.length > 0) {
    // Service-role insert bypasses the get_my_company_id() column default —
    // company_id must be stamped explicitly.
    const rows = usable.map(g => ({
      company_id: invite.company_id,
      user_id:    user.id,
      project_id: g.project_id,
      module:     g.module,
      can_edit:   g.can_edit,
      granted_by: invite.invited_by,
    }))
    const { error: upErr } = await admin
      .from("project_access")
      .upsert(rows, { onConflict: "user_id,project_id,module" })
    if (upErr) {
      console.error("[claim-grants] upsert failed", upErr)
      // project_grants stays intact — the client retry re-runs the claim.
      return NextResponse.json({ error: "Could not set up project access" }, { status: 500 })
    }
  }

  // CONSUME the payload: the upsert (if any) succeeded, so null out
  // project_grants before responding — the token can never re-materialize
  // grants again (e.g. after an admin revokes access via Manage access).
  const { error: consumeErr } = await admin
    .from("company_invites")
    .update({ project_grants: null })
    .eq("id", invite.id)
  if (consumeErr) {
    // Grants ARE materialized; only the consumption failed. Fail loudly so
    // the client retries — the retry re-upserts idempotently and re-attempts
    // the null-out. Never respond ok while the payload is still replayable.
    console.error("[claim-grants] failed to consume project_grants", consumeErr)
    return NextResponse.json({ error: "Could not finalize access setup" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, granted: usable.length, skipped })
}
