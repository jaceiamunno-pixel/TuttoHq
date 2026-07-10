import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import ResetPasswordForm from "./reset-password-form"

/**
 * `/auth/reset-password` — set a new password, reachable ONLY with a live
 * (recovery) session.
 *
 * The gate is server-side and single-shot: read the session from cookies and, if
 * there is no authenticated user, redirect to /login. A recovery link routes the
 * user through /auth/callback first, which establishes the session cookie before
 * sending them here — so a legitimate visitor always has a user, and a direct/
 * stale visit has none and bounces. Because the check runs once on the server
 * (not a client effect), there is no redirect loop when the session is absent.
 *
 * This route is intentionally NOT in middleware's PUBLIC_PATHS, so the same
 * unauthenticated → /login bounce is also enforced one layer up. Two gates, one
 * behavior.
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  return <ResetPasswordForm />
}
