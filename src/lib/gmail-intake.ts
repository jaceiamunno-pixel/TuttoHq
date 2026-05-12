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

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCEPTED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
])

const MAX_PDF_BYTES = 20 * 1024 * 1024

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectAttachments(part: GmailPart, out: GmailPart[] = []): GmailPart[] {
  if (part.filename?.trim() && ACCEPTED_MIMES.has(part.mimeType ?? "")) {
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
  // Service-role client bypasses RLS — this runs server-side outside a user session
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("user_id, access_token, refresh_token, token_expiry, history_id")
    .eq("gmail_address", emailAddress)
    .single()

  if (!conn) return

  // Refresh access token if it expires within 5 minutes
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

  // Use the stored historyId as the start of the range to avoid missing messages
  const startHistoryId = (conn.history_id as string) ?? historyId

  const histRes = await gmailGet(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded`
  )
  const histData = await histRes.json()

  // Advance the cursor regardless of whether there are new messages
  await supabase
    .from("gmail_connections")
    .update({ history_id: historyId })
    .eq("gmail_address", emailAddress)

  if (!Array.isArray(histData.history) || histData.history.length === 0) return

  // Deduplicate message IDs across history items
  const messageIds = new Set<string>()
  for (const item of histData.history as Array<{ messagesAdded?: Array<{ message: { id: string } }> }>) {
    for (const added of item.messagesAdded ?? []) {
      messageIds.add(added.message.id)
    }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  for (const msgId of messageIds) {
    await processMessage(supabase, anthropic, accessToken, msgId, conn.user_id as string)
  }
}

// ─── Per-message processing ───────────────────────────────────────────────────

async function processMessage(
  supabase: AnySupabase,
  anthropic: Anthropic,
  accessToken: string,
  messageId: string,
  userId: string
): Promise<void> {
  const res = await gmailGet(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`
  )
  if (!res.ok) return
  const msg = await res.json()

  const headers   = (msg.payload?.headers ?? []) as Array<{ name: string; value: string }>
  const subject   = getHeader(headers, "Subject") || "(no subject)"
  const fromRaw   = getHeader(headers, "From")
  const dateHeader = getHeader(headers, "Date")

  // Parse "Display Name <addr@example.com>" format
  const fromMatch  = fromRaw.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/)
  const senderName  = fromMatch?.[1]?.trim() || fromRaw
  const senderEmail = fromMatch?.[2]?.trim() || fromRaw
  const receivedAt  = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()

  const attachments = collectAttachments(msg.payload ?? {})
  if (attachments.length === 0) return

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

  // Download bytes — small attachments are inlined; larger ones need a separate call
  let base64url: string
  if (part.body?.data) {
    base64url = part.body.data
  } else if (part.body?.attachmentId) {
    const r = await gmailGet(
      accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${part.body.attachmentId}`
    )
    if (!r.ok) return
    const d = await r.json()
    base64url = d.data as string
  } else {
    return
  }

  // Gmail uses URL-safe base64 (- and _); convert to standard before decoding
  const fileBytes = Buffer.from(base64url.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  const mimeType  = part.mimeType ?? "application/octet-stream"
  const isPdf     = mimeType === "application/pdf"
  const ext       = isPdf ? "pdf" : "docx"
  const fileName  = part.filename?.trim() || `attachment_${Date.now()}.${ext}`

  // Classify with Claude using the exact prompt from the spec
  const classification = await classifyDocument(anthropic, fileBytes, fileName, subject, senderName, isPdf)

  // Upload to Supabase storage
  const safeName    = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const storagePath = `gmail-intake/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${safeName}`

  const { error: uploadErr } = await supabase.storage
    .from("submittals")
    .upload(storagePath, fileBytes, { contentType: mimeType })

  if (uploadErr) {
    console.error("[gmail-intake] storage upload failed:", uploadErr.message)
    return
  }

  const reviewStatus = (classification.confidence_score ?? 0) >= 70 ? "Received" : "Needs Review"

  const { error: dbErr } = await supabase.from("submittals").insert({
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
  })

  if (dbErr) {
    console.error("[gmail-intake] db insert failed:", dbErr.message)
  }
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

  // Exact prompt from spec
  const prompt = `You are a construction submittal expert. Based on the following information about a submittal document, determine the correct CSI MasterFormat division and section. Return ONLY a JSON object with these exact fields: division_number, division_name, section_number, section_name, confidence_score (0-100), reasoning

${context}`

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let content: any

    if (isPdf && fileBytes.length <= MAX_PDF_BYTES) {
      // Send PDF natively so Claude can read the full document text
      content = [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: fileBytes.toString("base64") },
        },
        { type: "text", text: prompt },
      ]
    } else {
      // Word docs or oversized PDFs — classify from filename + subject + sender only
      content = prompt
    }

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content }],
    })

    const text  = response.content[0].type === "text" ? response.content[0].text : ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return fallbackResult(fileName)

    return { ...fallbackResult(fileName), ...JSON.parse(match[0]) }
  } catch {
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
