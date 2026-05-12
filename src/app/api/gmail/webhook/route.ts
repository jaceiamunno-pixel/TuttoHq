import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { refreshAccessToken, setupWatch } from "@/lib/gmail"

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.message?.data) return NextResponse.json({ ok: true })

  let notification: { emailAddress?: string; historyId?: string }
  try {
    notification = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"))
  } catch {
    return NextResponse.json({ ok: true })
  }

  const { emailAddress, historyId } = notification
  if (!emailAddress || !historyId) return NextResponse.json({ ok: true })

  // Use service role to bypass RLS — this endpoint is called by Google, not by a logged-in user
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("user_id, access_token, refresh_token, token_expiry, watch_expiry")
    .eq("gmail_address", emailAddress)
    .single()

  if (!conn) return NextResponse.json({ ok: true })

  // Update the last-processed historyId
  await supabase
    .from("gmail_connections")
    .update({ history_id: historyId })
    .eq("gmail_address", emailAddress)

  // Auto-renew watch if it expires within 24 hours
  const watchExpiry = conn.watch_expiry ? new Date(conn.watch_expiry as string).getTime() : 0
  if (watchExpiry - Date.now() < 24 * 60 * 60 * 1000) {
    try {
      let accessToken = conn.access_token as string
      const tokenExpiry = conn.token_expiry ? new Date(conn.token_expiry as string).getTime() : 0

      if (Date.now() + 5 * 60 * 1000 >= tokenExpiry) {
        const refreshed = await refreshAccessToken(conn.refresh_token as string)
        accessToken = refreshed.access_token
        await supabase
          .from("gmail_connections")
          .update({
            access_token: accessToken,
            token_expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          })
          .eq("gmail_address", emailAddress)
      }

      const watchData = await setupWatch(accessToken)
      await supabase
        .from("gmail_connections")
        .update({ watch_expiry: new Date(parseInt(watchData.expiration)).toISOString() })
        .eq("gmail_address", emailAddress)
    } catch {
      // Non-fatal — will retry on the next notification
    }
  }

  return NextResponse.json({ ok: true })
}
