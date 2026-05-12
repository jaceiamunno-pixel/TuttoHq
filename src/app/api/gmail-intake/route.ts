import { NextRequest, NextResponse, after } from "next/server"
import { processGmailNotification } from "@/lib/gmail-intake"

export async function POST(req: NextRequest) {
  // Validate shared secret — the Pub/Sub subscription push URL must include ?token=<GMAIL_WEBHOOK_SECRET>
  const token = req.nextUrl.searchParams.get("token")
  if (!process.env.GMAIL_WEBHOOK_SECRET || token !== process.env.GMAIL_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.message?.data) return NextResponse.json({ ok: true })

  // Google Pub/Sub wraps the Gmail notification as base64-encoded JSON
  let notification: { emailAddress?: string; historyId?: string }
  try {
    notification = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"))
  } catch {
    return NextResponse.json({ ok: true })
  }

  const { emailAddress, historyId } = notification
  if (!emailAddress || !historyId) return NextResponse.json({ ok: true })

  // Acknowledge receipt immediately — Google expects 200 within a few seconds.
  // The actual processing runs after the response is sent.
  after(async () => {
    try {
      await processGmailNotification(emailAddress, historyId)
    } catch (err) {
      console.error("[gmail-intake] unhandled error:", err)
    }
  })

  return NextResponse.json({ ok: true })
}
