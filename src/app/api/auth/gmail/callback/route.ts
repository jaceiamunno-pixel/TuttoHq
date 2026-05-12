import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { setupWatch } from "@/lib/gmail"

const BASE = () => process.env.NEXT_PUBLIC_APP_URL!
const redirect = (path: string) => NextResponse.redirect(`${BASE()}${path}`)

export async function GET(req: NextRequest) {
  const cookieStore = await cookies()
  const savedState = cookieStore.get("gmail_oauth_state")?.value
  cookieStore.delete("gmail_oauth_state")

  const { searchParams } = new URL(req.url)
  const code  = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")

  if (error) return redirect(`/settings?tab=gmail&error=${encodeURIComponent(error)}`)
  if (!code || !state || state !== savedState) {
    return redirect("/settings?tab=gmail&error=invalid_state")
  }

  // Exchange authorization code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${BASE()}/api/auth/gmail/callback`,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  })

  if (!tokenRes.ok) return redirect("/settings?tab=gmail&error=token_exchange_failed")

  const { access_token, refresh_token, expires_in } = await tokenRes.json()
  if (!refresh_token) return redirect("/settings?tab=gmail&error=no_refresh_token")

  // Get Gmail address from userinfo
  const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  const { email: gmail_address } = await userinfoRes.json()
  if (!gmail_address) return redirect("/settings?tab=gmail&error=userinfo_failed")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect("/settings?tab=gmail&error=unauthorized")

  const token_expiry = new Date(Date.now() + expires_in * 1000).toISOString()

  const { error: upsertErr } = await supabase
    .from("gmail_connections")
    .upsert(
      { user_id: user.id, gmail_address, access_token, refresh_token, token_expiry },
      { onConflict: "user_id" }
    )

  if (upsertErr) return redirect("/settings?tab=gmail&error=db_error")

  // Setup Gmail watch — non-fatal if Pub/Sub not configured
  try {
    const watchData = await setupWatch(access_token)
    await supabase
      .from("gmail_connections")
      .update({
        watch_expiry: new Date(parseInt(watchData.expiration)).toISOString(),
        history_id: watchData.historyId,
      })
      .eq("user_id", user.id)
  } catch {
    // Pub/Sub not configured — watch won't run, polling can be used instead
  }

  return redirect("/settings?tab=gmail&connected=1")
}
