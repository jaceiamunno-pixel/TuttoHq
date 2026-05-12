import Anthropic from "@anthropic-ai/sdk"
import { createClient as createServiceClient, SupabaseClient } from "@supabase/supabase-js"
import { refreshAccessToken } from "./gmail"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

// ─── Types ────────────────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
  headers?: Array<{ name: string; value: string }>
}

interface ClassificationResult {
  division_number: string | null
  division_name: string | null
  section_number: string | null
  section_name: string | null
  confidence_score: number | null
  reasoning: string | null
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(step: string, data?: unknown) {
  const payload = data !== undefined ? ` ${JSON.stringify(data)}` : ""
  console.log(`[gmail-intake] ${step}${payload}`)
}

function logError(step: string, err: unknown) {
  const detail = err instanceof Error
    ? `${err.message}\n${err.stack}`
    : JSON.stringify(err)
  console.error(`[gmail-intake] FAIL ${step}: ${detail}`)
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Accepted MIME types for attachments — also check filename extension as a fallback
// because some mail clients send PDFs with application/octet-stream
const ACCEPTED_MIMES = new Set([
  "application/pdf",
  "application/octet-stream",   // generic binary — confirmed by extension below
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/x-pdf",
])

const PDF_EXTENSIONS  = new Set([".pdf"])
const WORD_EXTENSIONS = new Set([".doc", ".docx"])

const MAX_PDF_BYTES = 20 * 1024 * 1024

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAcceptedAttachment(part: GmailPart): boolean {
  const name = part.filename?.trim() ?? ""
  if (!name) return false
  const ext  = name.slice(name.lastIndexOf(".")).toLowerCase()
  const mime = part.mimeType ?? ""
  return ACCEPTED_MIMES.has(mime) && (PDF_EXTENSIONS.has(ext) || WORD_EXTENSIONS.has(ext))
}

function collectAttachments(part: GmailPart, out: GmailPart[] = []): GmailPart[] {
  if (isAcceptedAttachment(part)) {
    out.push(part)
  }
  for (const child of part.parts ?? []) {
    collectAttachments(child, out)
  }
  return out
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""
}

async function gmailGet(token: string, url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } })
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processGmailNotification(emailAddress: string, historyId: string): Promise<void> {
  log("start", { emailAddress, historyId })

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    log("FAIL env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set")
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    log("FAIL env: ANTHROPIC_API_KEY is not set")
    return
  }

  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  // ── 1. Look up the stored connection ───────────────────────────────────────
  const { data: conn, error: connErr } = await supabase
    .from("gmail_connections")
    .select("user_id, access_token, refresh_token, token_expiry, history_id")
    .eq("gmail_address", emailAddress)
    .single()

  if (connErr || !conn) {
    log("FAIL connection-lookup", { emailAddress, error: connErr?.message ?? "no row returned" })
    return
  }
  log("connection-found", { userId: conn.user_id, storedHistoryId: conn.history_id })

  // ── 2. Ensure a valid access token ─────────────────────────────────────────
  let accessToken = conn.access_token as string
  const tokenExpiry = conn.token_expiry ? new Date(conn.token_expiry as string).getTime() : 0
  if (Date.now() + 5 * 60 * 1000 >= tokenExpiry) {
    log("token-refresh: triggering refresh")
    try {
      const refreshed = await refreshAccessToken(conn.refresh_token as string)
      accessToken = refreshed.access_token
      await supabase
        .from("gmail_connections")
        .update({
          access_token: accessToken,
          token_expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        })
        .eq("gmail_address", emailAddress)
      log("token-refresh: success")
    } catch (err) {
      logError("token-refresh", err)
      return
    }
  } else {
    log("token-refresh: token still valid")
  }

  // ── 3. Fetch Gmail history since last cursor ────────────────────────────────
  const startHistoryId = (conn.history_id as string) ?? historyId
  log("history-fetch", { startHistoryId, incomingHistoryId: historyId })

  const histRes = await gmailGet(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded`
  )
  const histData = await histRes.json()

  log("history-response", {
    status: histRes.status,
    hasHistory: Array.isArray(histData.history),
    historyLength: histData.history?.length ?? 0,
    error: histData.error ?? null,
  })

  // Advance the cursor regardless so we don't reprocess on the next notification
  await supabase
    .from("gmail_connections")
    .update({ history_id: historyId })
    .eq("gmail_address", emailAddress)

  if (histData.error) {
    log("FAIL history-api-error", histData.error)
    return
  }

  if (!Array.isArray(histData.history) || histData.history.length === 0) {
    log("history-empty: no new messages to process")
    return
  }

  // ── 4. Collect unique message IDs ──────────────────────────────────────────
  const messageIds = new Set<string>()
  for (const item of histData.history as Array<{ messagesAdded?: Array<{ message: { id: string } }> }>) {
    for (const added of item.messagesAdded ?? []) {
      messageIds.add(added.message.id)
    }
  }
  log("messages-found", { count: messageIds.size, ids: [...messageIds] })

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  for (const msgId of messageIds) {
    await processMessage(supabase, anthropic, accessToken, msgId, conn.user_id as string)
  }

  log("done", { emailAddress, processedMessages: messageIds.size })
}

// ─── Per-message processing ───────────────────────────────────────────────────

async function processMessage(
  supabase: AnySupabase,
  anthropic: Anthropic,
  accessToken: string,
  messageId: string,
  userId: string
): Promise<void> {
  log("message-fetch", { messageId })

  const res = await gmailGet(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`
  )

  if (!res.ok) {
    log("FAIL message-fetch", { messageId, status: res.status, statusText: res.statusText })
    return
  }

  const msg     = await res.json()
  const headers = (msg.payload?.headers ?? []) as Array<{ name: string; value: string }>
  const subject = getHeader(headers, "Subject") || "(no subject)"
  const fromRaw = getHeader(headers, "From")
  const dateHeader = getHeader(headers, "Date")

  const fromMatch   = fromRaw.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/)
  const senderName  = fromMatch?.[1]?.trim() || fromRaw
  const senderEmail = fromMatch?.[2]?.trim() || fromRaw
  const receivedAt  = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()

  const attachments = collectAttachments(msg.payload ?? {})

  log("message-parsed", {
    messageId,
    subject,
    from: fromRaw,
    date: dateHeader,
    attachmentCount: attachments.length,
    attachments: attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.body?.size })),
  })

  if (attachments.length === 0) {
    log("message-skip: no accepted attachments", { messageId, subject })
    return
  }

  for (const part of attachments) {
    await processAttachment({
      supabase, anthropic, accessToken, messageId,
      part, subject, senderName, senderEmail, receivedAt, userId,
    })
  }
}

// ─── Per-attachment processing ────────────────────────────────────────────────

interface AttachmentCtx {
  supabase: AnySupabase
  anthropic: Anthropic
  accessToken: string
  messageId: string
  part: GmailPart
  subject: string
  senderName: string
  senderEmail: string
  receivedAt: string
  userId: string
}

async function processAttachment(ctx: AttachmentCtx): Promise<void> {
  const { supabase, anthropic, accessToken, messageId, part,
          subject, senderName, senderEmail, receivedAt, userId } = ctx

  const fileName = part.filename?.trim() || `attachment_${Date.now()}.bin`
  log("attachment-start", { fileName, mimeType: part.mimeType, bodySize: part.body?.size, hasInlineData: !!part.body?.data, hasAttachmentId: !!part.body?.attachmentId })

  // ── Download bytes ─────────────────────────────────────────────────────────
  let base64url: string

  if (part.body?.data) {
    base64url = part.body.data
    log("attachment-data: using inline body data")
  } else if (part.body?.attachmentId) {
    const attachUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${part.body.attachmentId}`
    log("attachment-data: fetching from API", { attachmentId: part.body.attachmentId })
    const r = await gmailGet(accessToken, attachUrl)
    if (!r.ok) {
      log("FAIL attachment-download", { status: r.status, statusText: r.statusText, fileName })
      return
    }
    const d = await r.json()
    base64url = d.data as string
    if (!base64url) {
      log("FAIL attachment-download: response had no data field", { fileName, responseKeys: Object.keys(d) })
      return
    }
  } else {
    log("FAIL attachment-skip: no body data and no attachmentId", { fileName })
    return
  }

  // Gmail uses URL-safe base64 — convert before decoding
  const fileBytes = Buffer.from(base64url.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  const mimeType  = part.mimeType ?? "application/octet-stream"
  const ext       = fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
  const isPdf     = ext === ".pdf"

  log("attachment-downloaded", { fileName, mimeType, bytes: fileBytes.length })

  // ── AI classification ──────────────────────────────────────────────────────
  const classification = await classifyDocument(anthropic, fileBytes, fileName, subject, senderName, isPdf)
  log("classification-result", {
    fileName,
    division_number: classification.division_number,
    section_number:  classification.section_number,
    confidence_score: classification.confidence_score,
    reasoning: classification.reasoning,
  })

  // ── Upload to Supabase storage ─────────────────────────────────────────────
  const safeName    = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const storagePath = `gmail-intake/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${safeName}`

  log("storage-upload-start", { bucket: "submittals", path: storagePath, bytes: fileBytes.length })
  const { data: storageData, error: uploadErr } = await supabase.storage
    .from("submittals")
    .upload(storagePath, fileBytes, { contentType: mimeType })

  if (uploadErr) {
    log("FAIL storage-upload", { path: storagePath, error: uploadErr.message, statusCode: (uploadErr as { statusCode?: string }).statusCode })
    return
  }
  log("storage-upload-ok", { path: storageData?.path ?? storagePath })

  // ── Insert database record ─────────────────────────────────────────────────
  const reviewStatus = (classification.confidence_score ?? 0) >= 70 ? "Received" : "Needs Review"

  const record = {
    file_name:     fileName,
    storage_path:  storagePath,
    mime_type:     mimeType,
    file_size:     fileBytes.length,
    csi_division:  classification.division_number,
    division_name: classification.division_name,
    csi_section:   classification.section_number,
    section_name:  classification.section_name,
    review_status: reviewStatus,
    ai_confidence: classification.confidence_score,
    ai_reasoning:  classification.reasoning,
    sender_email:  senderEmail,
    received_at:   receivedAt,
    project_id:    null,
    status:        "active",
    uploaded_by:   userId,
  }

  log("db-insert-start", { file_name: fileName, review_status: reviewStatus, uploaded_by: userId })
  const { error: dbErr } = await supabase.from("submittals").insert(record)

  if (dbErr) {
    log("FAIL db-insert", { error: dbErr.message, code: dbErr.code, details: dbErr.details, hint: dbErr.hint, record_keys: Object.keys(record) })
    return
  }

  log("db-insert-ok", { fileName, reviewStatus })
}

// ─── AI classification ────────────────────────────────────────────────────────

async function classifyDocument(
  anthropic: Anthropic,
  fileBytes: Buffer,
  fileName: string,
  subject: string,
  senderName: string,
  isPdf: boolean
): Promise<ClassificationResult> {
  const context = [
    `Filename: ${fileName}`,
    `Email Subject: ${subject}`,
    `Sender: ${senderName}`,
  ].join("\n")

  const prompt = `You are a construction submittal expert. Based on the following information about a submittal document, determine the correct CSI MasterFormat division and section. Return ONLY a JSON object with these exact fields: division_number, division_name, section_number, section_name, confidence_score (0-100), reasoning

${context}`

  log("classify-start", { fileName, isPdf, fileSizeKb: Math.round(fileBytes.length / 1024) })

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let content: any

    if (isPdf && fileBytes.length <= MAX_PDF_BYTES) {
      content = [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: fileBytes.toString("base64") },
        },
        { type: "text", text: prompt },
      ]
      log("classify: sending PDF natively to Claude")
    } else {
      content = prompt
      log("classify: text-only (Word doc or oversized PDF)")
    }

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content }],
    })

    const rawText = response.content[0].type === "text" ? response.content[0].text : ""
    log("classify-raw-response", { fileName, rawText: rawText.slice(0, 500) })

    const match = rawText.match(/\{[\s\S]*\}/)
    if (!match) {
      log("FAIL classify: no JSON object in response", { fileName, rawText })
      return fallbackResult(fileName)
    }

    const parsed = JSON.parse(match[0])
    log("classify-parsed", { fileName, parsed })
    return { ...fallbackResult(fileName), ...parsed }

  } catch (err) {
    logError("classify", err)
    return fallbackResult(fileName)
  }
}

function fallbackResult(fileName: string): ClassificationResult {
  return {
    division_number:  null,
    division_name:    null,
    section_number:   null,
    section_name:     null,
    confidence_score: 0,
    reasoning:        `Auto-classification failed for "${fileName}" — manual review required.`,
  }
}
