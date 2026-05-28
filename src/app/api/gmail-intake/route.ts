import { NextRequest, NextResponse, after } from "next/server"
import { processGmailNotification } from "@/lib/gmail-intake"

export const maxDuration = 60

export async function POST(req: NextRequest) {
  // Validate shared secret
  const token = req.nextUrl.searchParams.get("token")
  if (!process.env.GMAIL_WEBHOOK_SECRET || token !== process.env.GMAIL_WEBHOOK_SECRET) {
    console.log("[gmail-intake] webhook: rejected — bad or missing token")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.message?.data) {
    console.log("[gmail-intake] webhook: no message.data in body", JSON.stringify(body))
    return NextResponse.json({ ok: true })
  }

  // Decode the Pub/Sub envelope
  let notification: { emailAddress?: string; historyId?: string }
  try {
    notification = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"))
  } catch (err) {
    console.error("[gmail-intake] webhook: failed to decode message.data", err)
    return NextResponse.json({ ok: true })
  }

  const { emailAddress, historyId } = notification
  console.log("[gmail-intake] webhook: decoded notification", { emailAddress, historyId })

  if (!emailAddress || !historyId) {
    console.log("[gmail-intake] webhook: notification missing emailAddress or historyId", notification)
    return NextResponse.json({ ok: true })
  }

  // Register async processing — runs after 200 is sent to Google
  after(async () => {
    console.log("[gmail-intake] after: starting processGmailNotification", { emailAddress, historyId })
    try {
      await processGmailNotification(emailAddress, historyId)
      console.log("[gmail-intake] after: processGmailNotification completed", { emailAddress })
    } catch (err) {
      console.error("[gmail-intake] after: unhandled error", err instanceof Error ? err.stack : err)
    }
  })

  console.log("[gmail-intake] webhook: returning 200, after() registered")
  return NextResponse.json({ ok: true })
}
