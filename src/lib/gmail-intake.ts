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

// A submittal package resolved from a [TTQ-…] tag in an inbound subject line.
interface PackageRef {
  id: string
  project_id: string
}

// A closeout package resolved from a [TTQ-CO-…] tag (Session K1). Inbound
// attachments to a closeout package always land as orphans in
// closeout_package_inbound — never auto-linked — for PM review.
interface CloseoutPackageRef {
  id: string
  project_id: string
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

// ─── Package match-back (Session I + K1) ────────────────────────────────────

// A dispatched package's tracking ref. The optional non-capturing (?:-CO)?
// group is the Session K1 discriminator: submittal packages ship as
// "[TTQ-AB12-7]" and closeout packages as "[TTQ-CO-AB12-7]". The capture
// keeps the full ref (incl. the "CO-" infix when present) so the resolver
// can branch on tag.startsWith("TTQ-CO-") to pick the right table —
// submittal_packages vs closeout_packages — without doing two lookups.
const PACKAGE_TAG_RE = /\[(TTQ(?:-CO)?-[A-Za-z0-9]+-\d+)\]/i

/** Normalize a CSI section to bare digits ("09 22 16" → "092216") for matching. */
function normalizeSection(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "")
}

/**
 * Resolve a dispatched package from a [TTQ-…] tag in an inbound subject line.
 * Scoped to the connection's company so a tag never resolves cross-tenant.
 *
 * Returns either a submittal-package ref (Session I) or a closeout-package
 * ref (Session K1), discriminated by the "-CO-" infix in the tag. Caller
 * branches on the `kind` field.
 */
type ResolvedPackage =
  | { kind: "submittal"; ref: PackageRef }
  | { kind: "closeout";  ref: CloseoutPackageRef }

async function resolvePackage(
  supabase: AnySupabase,
  subject: string,
  companyId: string | null,
): Promise<ResolvedPackage | null> {
  const m = subject.match(PACKAGE_TAG_RE)
  if (!m) return null
  const tag = m[1].toUpperCase()

  const table = tag.startsWith("TTQ-CO-") ? "closeout_packages" : "submittal_packages"
  let query = supabase
    .from(table)
    .select("id, project_id, company_id")
    .eq("package_number", tag)
  if (companyId) query = query.eq("company_id", companyId)

  const { data, error } = await query.limit(1)
  if (error || !data || data.length === 0) {
    log("package-match: tag found but no package", { tag, table, error: error?.message ?? null })
    return null
  }
  log("package-match: resolved", { tag, table, packageId: data[0].id })
  const ref = { id: data[0].id as string, project_id: data[0].project_id as string }
  return table === "closeout_packages"
    ? { kind: "closeout",  ref }
    : { kind: "submittal", ref }
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
    .select("user_id, company_id, access_token, refresh_token, token_expiry, history_id")
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
    await processMessage(
      supabase, anthropic, accessToken, msgId,
      conn.user_id as string, (conn.company_id as string | null) ?? null,
      emailAddress,
    )
  }

  log("done", { emailAddress, processedMessages: messageIds.size })
}

// ─── Per-message processing ───────────────────────────────────────────────────

async function processMessage(
  supabase: AnySupabase,
  anthropic: Anthropic,
  accessToken: string,
  messageId: string,
  userId: string,
  companyId: string | null,
  // The connected mailbox's own Gmail address — the From: address on every
  // outbound TuttoHQ dispatches from this connection. Used by the self-loop
  // guard below to discriminate our own outbound (skip) from legitimate sub
  // replies (let match-back handle them).
  connectedMailbox: string,
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

  // ── Self-loop guard (K2) ────────────────────────────────────────────────────
  // Skip only when an inbound message is our OWN outbound looping back through
  // the connected mailbox's Gmail history: subject carries a TuttoHQ-issued
  // [TTQ-...] tracking ref AND the sender is the connected mailbox itself.
  // Comparison is lowercase-vs-lowercase because Gmail addresses are
  // case-insensitive. A [TTQ-...] subject from any other sender is a
  // legitimate sub reply and falls through to the Session I/K1 match-back
  // resolver below.
  //
  // Defensive: if connectedMailbox is empty (would indicate an upstream
  // wiring bug — processGmailNotification uses it as the connection lookup
  // key), we over-process rather than risk dropping a real reply silently.
  //
  // The skip is recorded in gmail_intake_skips for observability. company_id
  // is set explicitly because its DEFAULT resolves to NULL under the
  // service-role client, and a NULL company_id would make the row invisible
  // to the read-only RLS policy. The (gmail_message_id, reason) UNIQUE +
  // ignoreDuplicates upsert option absorb Pub/Sub redeliveries silently.
  if (PACKAGE_TAG_RE.test(subject)) {
    const fromAddr = (senderEmail || "").toLowerCase().trim()
    const ownAddr  = connectedMailbox.toLowerCase().trim()
    const isSelfLoop = !!ownAddr && !!fromAddr && fromAddr === ownAddr

    if (!ownAddr) {
      log("self-loop-check: connectedMailbox unavailable — falling through", { messageId, subject })
    } else if (isSelfLoop && !companyId) {
      // Detected self-loop, but cannot satisfy gmail_intake_skips.company_id
      // NOT NULL — so we cannot audit. Fall through with a warning rather
      // than silently drop: better to risk re-processing one bogus row (it
      // hits the same companyId guard in processAttachment and bails) than
      // to make a self-loop invisible to ops.
      log("self-loop-check: detected but companyId missing — falling through without audit", { messageId, subject })
    } else if (isSelfLoop) {
      const { error: skipErr } = await supabase
        .from("gmail_intake_skips")
        .upsert(
          {
            gmail_message_id: messageId,
            subject,
            sender_email:     senderEmail || null,
            reason:           "self_loop_skipped",
            company_id:       companyId,
          },
          { onConflict: "gmail_message_id,reason", ignoreDuplicates: true },
        )
      if (skipErr) {
        log("FAIL self-loop-skip-log", { messageId, error: skipErr.message, code: skipErr.code })
      } else {
        log("self-loop-skipped", { messageId, subject, senderEmail })
      }
      return
    }
    // External sender, missing mailbox, or self-loop-without-companyId → fall
    // through to match-back / normal processing.
  }

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

  // If the subject carries a [TTQ-…] tag, this is a reply to a dispatched
  // package — its attachments match back instead of landing as fresh intake.
  const pkg = await resolvePackage(supabase, subject, companyId)

  for (const part of attachments) {
    await processAttachment({
      supabase, anthropic, accessToken, messageId,
      part, subject, senderName, senderEmail, receivedAt, userId, companyId, pkg,
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
  // The gmail connection's company — must be set explicitly on every insert.
  // The submittals.company_id column DEFAULT (get_my_company_id()) resolves to
  // NULL under the service-role client, and a NULL company_id makes the row
  // invisible to every RLS SELECT policy.
  companyId: string | null
  // Set when the message subject carried a [TTQ-…] package tag.
  // Discriminated union — submittal vs closeout — drives different
  // match-back behavior (in-place fulfillment vs always-orphan).
  pkg: ResolvedPackage | null
}

async function processAttachment(ctx: AttachmentCtx): Promise<void> {
  const { supabase, anthropic, accessToken, messageId, part,
          subject, senderName, senderEmail, receivedAt, userId, companyId, pkg } = ctx

  const fileName = part.filename?.trim() || `attachment_${Date.now()}.bin`
  log("attachment-start", { fileName, mimeType: part.mimeType, bodySize: part.body?.size, hasInlineData: !!part.body?.data, hasAttachmentId: !!part.body?.attachmentId })

  // Guard: without a company_id every row this function writes would be
  // invisible to RLS. A missing one means the gmail_connections row itself is
  // misconfigured — fail loudly here rather than silently dropping the intake.
  if (!companyId) {
    log("FAIL company-id-missing: gmail connection has no company_id — skipping", { fileName })
    return
  }

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

  // ── Deduplication check ────────────────────────────────────────────────────
  // Two dedup tables depending on whether this reply belongs to a closeout
  // package or anything else. In both cases the key is (messageId, fileName)
  // — so a Pub/Sub redelivery never re-applies the same attachment.
  if (pkg?.kind === "closeout") {
    const { data: existingInbound } = await supabase
      .from("closeout_package_inbound")
      .select("id, file_name")
      .eq("gmail_message_id", messageId)
    if ((existingInbound ?? []).some(r => r.file_name === fileName)) {
      log("attachment-skip: already processed (closeout inbound)", { fileName, messageId })
      return
    }
  } else {
    // Match the messageId + filename against both file_name (fresh intake /
    // orphan rows) and received_file_name (an expected item fulfilled in
    // place by match-back), across ALL statuses.
    const { data: existing } = await supabase
      .from("submittals")
      .select("id, file_name, received_file_name")
      .eq("gmail_message_id", messageId)

    if ((existing ?? []).some(r => r.file_name === fileName || r.received_file_name === fileName)) {
      log("attachment-skip: already processed", { fileName, messageId })
      return
    }
  }

  // ── Upload to Supabase storage ─────────────────────────────────────────────
  // Tenant-isolated path ({company_id}/...) so the new storage RLS can scope.
  // companyId is guaranteed non-null at this point — guarded above.
  const safeName    = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const storagePath = `${companyId}/gmail-intake/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${safeName}`

  log("storage-upload-start", { bucket: "submittals", path: storagePath, bytes: fileBytes.length })
  const { data: storageData, error: uploadErr } = await supabase.storage
    .from("submittals")
    .upload(storagePath, fileBytes, { contentType: mimeType })

  if (uploadErr) {
    log("FAIL storage-upload", { path: storagePath, error: uploadErr.message, statusCode: (uploadErr as { statusCode?: string }).statusCode })
    return
  }
  log("storage-upload-ok", { path: storageData?.path ?? storagePath })

  // ── Package match-back ─────────────────────────────────────────────────────
  // Submittal package (Session I): try to fulfil an expected item in place;
  //   if ambiguous, file as an orphan submittal tagged to the package.
  // Closeout package (Session K1): ALWAYS file as an orphan in
  //   closeout_package_inbound. The PM places it onto an item by hand from
  //   the package detail view — closeout items have no csi_section analog,
  //   so auto-linking would be guesswork.
  if (pkg?.kind === "submittal") {
    await matchBackAttachment({
      supabase, pkg: pkg.ref, classification, fileName, storagePath, mimeType,
      fileSize: fileBytes.length, senderEmail, receivedAt, messageId, userId, companyId,
    })
    return
  }
  if (pkg?.kind === "closeout") {
    await orphanCloseoutAttachment({
      supabase, pkg: pkg.ref, fileName, storagePath, mimeType,
      fileSize: fileBytes.length, senderEmail, receivedAt, messageId, companyId,
    })
    return
  }

  // ── Insert database record ─────────────────────────────────────────────────
  const reviewStatus = (classification.confidence_score ?? 0) >= 70 ? "Received" : "Needs Review"

  const record = {
    file_name:       fileName,
    storage_path:    storagePath,
    mime_type:       mimeType,
    file_size:       fileBytes.length,
    csi_division:    classification.division_number,
    division_name:   classification.division_name,
    csi_section:     classification.section_number,
    section_name:    classification.section_name,
    review_status:   reviewStatus,
    ai_confidence:   classification.confidence_score,
    ai_reasoning:    classification.reasoning,
    sender_email:    senderEmail,
    received_at:     receivedAt,
    gmail_message_id: messageId,
    project_id:      null,
    company_id:      companyId,
    status:          "active",
    uploaded_by:     userId,
  }

  log("db-insert-start", { file_name: fileName, review_status: reviewStatus, uploaded_by: userId })
  const { error: dbErr } = await supabase.from("submittals").insert(record)

  if (dbErr) {
    log("FAIL db-insert", { error: dbErr.message, code: dbErr.code, details: dbErr.details, hint: dbErr.hint, record_keys: Object.keys(record) })
    return
  }

  log("db-insert-ok", { fileName, reviewStatus })
}

// ─── Package match-back ─────────────────────────────────────────────────────

interface MatchBackCtx {
  supabase: AnySupabase
  pkg: PackageRef
  classification: ClassificationResult
  fileName: string
  storagePath: string
  mimeType: string
  fileSize: number
  senderEmail: string
  receivedAt: string
  messageId: string
  userId: string
  companyId: string | null
}

interface PackageItemSubmittal {
  id: string
  csi_section: string | null
  received_date: string | null
}

/**
 * Match an inbound attachment to a dispatched package.
 *
 * Unambiguous case — exactly one still-unreceived expected item shares the
 * attachment's classified spec section: the item is fulfilled in place
 * (file attached, received_date set), and the DB trigger advances the
 * package's status.
 *
 * Ambiguous case — zero or several candidates: the reply is filed as an
 * orphan submittal tagged to the package, surfaced as "Needs review" in the
 * package detail view so the PM can place it by hand. Never auto-links a
 * guess.
 */
async function matchBackAttachment(ctx: MatchBackCtx): Promise<void> {
  const { supabase, pkg, classification, fileName, storagePath, mimeType,
          fileSize, senderEmail, receivedAt, messageId, userId, companyId } = ctx

  const receivedDate = receivedAt.slice(0, 10)
  const wantSection = normalizeSection(classification.section_number)

  const { data: itemRows } = await supabase
    .from("submittal_package_items")
    .select("submittal_id, submittals(id, csi_section, received_date)")
    .eq("package_id", pkg.id)

  const candidates: PackageItemSubmittal[] = (itemRows ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => r.submittals as PackageItemSubmittal | null)
    .filter((s): s is PackageItemSubmittal =>
      !!s && !s.received_date && !!wantSection && normalizeSection(s.csi_section) === wantSection)

  if (candidates.length === 1) {
    const target = candidates[0]
    const { error } = await supabase
      .from("submittals")
      .update({
        storage_path:            storagePath,
        mime_type:               mimeType,
        file_size:               fileSize,
        received_date:           receivedDate,
        received_file_name:      fileName,
        received_via_package_id: pkg.id,
        sender_email:            senderEmail,
        received_at:             receivedAt,
        gmail_message_id:        messageId,
        review_status:           "Received",
      })
      .eq("id", target.id)
    if (error) {
      log("FAIL package-match-link", { packageId: pkg.id, submittalId: target.id, error: error.message })
      return
    }
    log("package-match-linked", { packageId: pkg.id, submittalId: target.id, section: wantSection })
    return
  }

  // Ambiguous — file as an orphan for PM review.
  const record = {
    file_name:               fileName,
    received_file_name:      fileName,
    storage_path:            storagePath,
    mime_type:               mimeType,
    file_size:               fileSize,
    csi_division:            classification.division_number,
    division_name:           classification.division_name,
    csi_section:             classification.section_number,
    section_name:            classification.section_name,
    review_status:           "Needs Review",
    ai_confidence:           classification.confidence_score,
    ai_reasoning:            classification.reasoning,
    sender_email:            senderEmail,
    received_at:             receivedAt,
    gmail_message_id:        messageId,
    project_id:              pkg.project_id,
    received_via_package_id: pkg.id,
    company_id:              companyId,
    source:                  "gmail",
    status:                  "active",
    uploaded_by:             userId,
  }
  const { error } = await supabase.from("submittals").insert(record)
  if (error) {
    log("FAIL package-match-orphan", { packageId: pkg.id, error: error.message })
    return
  }
  log("package-match-orphan", { packageId: pkg.id, candidateCount: candidates.length, section: wantSection })
}

// ─── Closeout package orphan (Session K1) ───────────────────────────────────

interface CloseoutOrphanCtx {
  supabase: AnySupabase
  pkg: CloseoutPackageRef
  fileName: string
  storagePath: string
  mimeType: string
  fileSize: number
  senderEmail: string
  receivedAt: string
  messageId: string
  // The gmail connection's company — must be set explicitly. The
  // closeout_package_inbound.company_id DEFAULT resolves to NULL under the
  // service-role client, which would make the row invisible to RLS.
  companyId: string | null
}

/**
 * File an inbound closeout-package attachment as a pending orphan in
 * closeout_package_inbound. Match-back is intentionally never automatic:
 * closeout items have no csi_section to compare against, so the PM places
 * each reply onto an expected item from the package detail view.
 */
async function orphanCloseoutAttachment(ctx: CloseoutOrphanCtx): Promise<void> {
  const { supabase, pkg, fileName, storagePath, mimeType, fileSize,
          senderEmail, receivedAt, messageId, companyId } = ctx

  const { error } = await supabase.from("closeout_package_inbound").insert({
    package_id:       pkg.id,
    file_name:        fileName,
    storage_path:     storagePath,
    mime_type:        mimeType,
    file_size:        fileSize,
    sender_email:     senderEmail,
    received_at:      receivedAt,
    gmail_message_id: messageId,
    status:           "pending",
    company_id:       companyId,
  })
  if (error) {
    log("FAIL closeout-orphan-insert", { packageId: pkg.id, error: error.message })
    return
  }
  log("closeout-orphan-filed", { packageId: pkg.id, fileName })
}

// ─── AI classification ────────────────────────────────────────────────────────

function extractCsiFromFilename(fileName: string): string | null {
  const base = fileName.slice(0, fileName.lastIndexOf(".")) || fileName
  // Match "09-22-16", "09 22 16", "09_22_16"
  const spaced = base.match(/\b(\d{2})[-\s_](\d{2})[-\s_](\d{2})\b/)
  if (spaced) return `${spaced[1]} ${spaced[2]} ${spaced[3]}`
  // Match compact "092216" at word boundary
  const compact = base.match(/\b(\d{2})(\d{2})(\d{2})\b/)
  if (compact) return `${compact[1]} ${compact[2]} ${compact[3]}`
  return null
}

async function classifyDocument(
  anthropic: Anthropic,
  fileBytes: Buffer,
  fileName: string,
  subject: string,
  senderName: string,
  isPdf: boolean
): Promise<ClassificationResult> {
  const embeddedSection = extractCsiFromFilename(fileName)

  const context = [
    `Filename: ${fileName}`,
    embeddedSection ? `Detected CSI section in filename: ${embeddedSection}` : null,
    `Email Subject: ${subject}`,
    `Sender: ${senderName}`,
  ].filter(Boolean).join("\n")

  const prompt = `You are a construction submittal classification expert with deep knowledge of CSI MasterFormat 2016.

Follow these steps in order:
1. If "Detected CSI section in filename" is present, use that section number directly — it is authoritative.
2. Read the document content for explicit section/division references.
3. Use the filename text, email subject, and sender as supporting signals.

CSI MasterFormat Divisions (partial — use your full knowledge beyond this list):
00 Procurement and Contracting Requirements
01 General Requirements
02 Existing Conditions
03 Concrete
04 Masonry
05 Metals (structural steel, metal fabrications, cold-formed STRUCTURAL framing)
06 Wood, Plastics, and Composites
07 Thermal and Moisture Protection
08 Openings (doors, windows, curtain walls, glazing hardware)
09 Finishes (gypsum board, plaster, tiling, flooring, painting, acoustic ceilings — includes NON-STRUCTURAL metal framing 09 22 16)
10 Specialties
11 Equipment
12 Furnishings
13 Special Construction
14 Conveying Equipment
21 Fire Suppression
22 Plumbing
23 HVAC
26 Electrical
27 Communications
28 Electronic Safety and Security
31 Earthwork
32 Exterior Improvements
33 Utilities

CRITICAL DISTINCTIONS:
- "Non-Structural Metal Framing" → Division 09, section 09 22 16 (NOT Division 05)
- "Structural Steel Framing" → Division 05
- Cold-formed metal framing for walls/ceilings/soffits → 09 22 16
- Cold-formed structural framing → 05 40 00
- Doors → 08 11 xx, Windows → 08 50 xx, Curtain Walls → 08 44 xx
- Roofing → 07 5x xx, Waterproofing → 07 1x xx, Insulation → 07 2x xx

Return ONLY a valid JSON object with no extra text:
{"division_number": "09", "division_name": "Finishes", "section_number": "09 22 16", "section_name": "Non-Structural Metal Framing", "confidence_score": 95, "reasoning": "Filename contains embedded section 09 22 16 and document confirms non-structural metal framing scope."}

Context:
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
      model: "claude-sonnet-4-6",
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
