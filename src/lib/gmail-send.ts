// ─── Gmail outbound send (Session I) ────────────────────────────────────────
// The existing Gmail integration is inbound-only. Sending uses the SAME OAuth
// grant: the connection's `gmail.modify` scope already authorizes
// users.messages.send, so no re-consent is needed. Pair this with
// getValidToken() from ./gmail to obtain a fresh access token.

export interface GmailAttachment {
  filename: string
  mimeType: string
  content: Uint8Array
}

export interface GmailSendOptions {
  to: string
  subject: string
  /** Plain-text body. */
  bodyText: string
  attachments?: GmailAttachment[]
  /** Set to keep a reply in an existing thread. */
  threadId?: string
}

/** RFC 2047 encode a header value when it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

/** Split base64 into 76-char lines per MIME. */
function chunk76(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64
}

/**
 * Send an email through Gmail as the connected account.
 * Returns the created message id and its thread id (stored for reply matching).
 */
export async function sendGmailMessage(
  accessToken: string,
  opts: GmailSendOptions,
): Promise<{ id: string; threadId: string }> {
  const boundary = `ttq_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
  const crlf = "\r\n"
  const parts: string[] = []

  parts.push(`To: ${opts.to}`)
  parts.push(`Subject: ${encodeHeader(opts.subject)}`)
  parts.push("MIME-Version: 1.0")
  parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  parts.push("")

  // Body part — base64 so any UTF-8 content survives transport.
  parts.push(`--${boundary}`)
  parts.push('Content-Type: text/plain; charset="UTF-8"')
  parts.push("Content-Transfer-Encoding: base64")
  parts.push("")
  parts.push(chunk76(Buffer.from(opts.bodyText, "utf8").toString("base64")))

  // Attachment parts
  for (const att of opts.attachments ?? []) {
    parts.push(`--${boundary}`)
    parts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`)
    parts.push("Content-Transfer-Encoding: base64")
    parts.push(`Content-Disposition: attachment; filename="${att.filename}"`)
    parts.push("")
    parts.push(chunk76(Buffer.from(att.content).toString("base64")))
  }

  parts.push(`--${boundary}--`)

  const raw = Buffer.from(parts.join(crlf), "utf8").toString("base64url")

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.threadId ? { raw, threadId: opts.threadId } : { raw }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message ?? `Gmail send failed (${res.status})`)
  }

  const data = await res.json()
  return { id: String(data.id), threadId: String(data.threadId) }
}
