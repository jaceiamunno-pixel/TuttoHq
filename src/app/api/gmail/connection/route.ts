import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data } = await supabase
    .from("gmail_connections")
    .select("gmail_address, watch_expiry, created_at")
    .eq("user_id", user.id)
    .single()

  if (!data) return NextResponse.json({ connected: false })

  return NextResponse.json({
    connected: true,
    gmail_address: data.gmail_address,
    watch_expiry: data.watch_expiry,
    created_at: data.created_at,
  })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("access_token")
    .eq("user_id", user.id)
    .single()

  if (conn) {
    // Stop the Gmail watch so Google stops sending notifications
    try {
      await fetch("https://gmail.googleapis.com/gmail/v1/users/me/stop", {
        method: "POST",
        headers: { Authorization: `Bearer ${conn.access_token}` },
      })
    } catch {
      // Non-fatal — connection will be deleted anyway
    }
  }

  const { error } = await supabase
    .from("gmail_connections")
    .delete()
    .eq("user_id", user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
