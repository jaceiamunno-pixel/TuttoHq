import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { RECOVERY_MARKER_COOKIE } from "../recovery-marker"
import ResetPasswordForm from "./reset-password-form"

/**
 * `/auth/reset-password` — set a new password. Reachable ONLY with a live
 * session AND a fresh recovery marker; either one missing bounces away. This is
 * the gate the whole branch exists for — the route that lets someone take over
 * an account — so the invariant is enforced, not just asserted.
 *
 * WHY A MARKER AND NOT THE SESSION TYPE: a Supabase recovery link mints a FULL
 * session that is byte-indistinguishable, server-side, from a normal login.
 * Traced to source and confirmed against prod: recovery verify issues
 * models.OTP, so its amr method is "otp" (matches auth.mfa_amr_claims) — and
 * "otp" is also email-OTP / magic-link sign-in, so NO JWT claim distinguishes
 * recovery from those. There is no server-verifiable "this is recovery" signal
 * to gate on. So we gate on a marker /auth/callback sets at the instant it
 * consumes a type=recovery link (see ../recovery-marker.ts).
 *
 * (b) marker closes the walk-up at the page layer. A session-level bypass via
 * direct supabase.auth.updateUser({password}) remains open at this layer and
 * CANNOT be closed here. It is closed only by GoTrue
 * SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD (which exempts recovery
 * sessions — verified: recovery verify issues models.OTP, and
 * OTP.IsRecovery() is true), NOT ...REQUIRE_REAUTHENTICATION (age-gated,
 * >24h only). Safe to enable here: GoTrue's native invite flow is unused —
 * all 13 users have invited_at IS NULL — so the Invite gap in IsRecovery()
 * is unreachable in this project.
 * FORWARD WARNING: IsRecovery() is also true for MagicLink. If a magic-link
 * sign-in is ever added, those sessions become exempt from
 * REQUIRE_CURRENT_PASSWORD too — anyone signed in by magic link could then
 * change the password with no current-password challenge. Same trap class as
 * "gate on otp": a plausible future change silently reopens this hole.
 *
 * The gate is server-side and single-shot (no client effect), so no redirect
 * loop: no session → /login; session but no marker → /dashboard (both terminal).
 * The route is also NOT in middleware's PUBLIC_PATHS, so the no-session bounce is
 * enforced one layer up too.
 */
export default async function ResetPasswordPage() {
  const cookieStore = await cookies()
  const hasRecoveryMarker = cookieStore.get(RECOVERY_MARKER_COOKIE)?.value === "1"

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")
  if (!hasRecoveryMarker) redirect("/dashboard")

  return <ResetPasswordForm />
}
