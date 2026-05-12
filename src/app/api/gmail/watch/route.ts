import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { setupWatch, getValidToken } from "@/lib/gmail"

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const accessToken = await getValidToken(supabase, user.id)
    const watchData = await setupWatch(accessToken)
    const watch_expiry = new Date(parseInt(watchData.expiration)).toISOString()

    await supabase
      .from("gmail_connections")
      .update({ watch_expiry, history_id: watchData.historyId })
      .eq("user_id", user.id)

    return NextResponse.json({ ok: true, watch_expiry })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Watch setup failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
