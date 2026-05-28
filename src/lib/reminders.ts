// ─── Package reminder runner (Session K2) ───────────────────────────────────
// Shared logic that drives the daily reminder cron for both submittal_packages
// and closeout_packages. Each package type has its own row table
// (*_package_reminders) and its own PDF composer; everything else is shared.
//
// Cadence resolution: every package row joins to company_settings so the cron
// can COALESCE per-package overrides over the company default. Effective max
// is min(cadence.length, max_count) so a misconfigured cadence shorter than
// max never tries to read past the end.
//
// Idempotency: the reminder row is inserted BEFORE the Gmail send. A second
// concurrent cron tick (or a retry) hits the UNIQUE(package_id,reminder_number)
// constraint and skips silently. If the insert succeeds but the Gmail send
// fails, the row stays in place with a NULL gmail_message_id, so the next
// cron run sees count=N+1 and won't re-attempt the failed reminder. That's
// an intentional choice — single-day visibility in logs beats the double-send
// risk of retrying.

import type { SupabaseClient } from "@supabase/supabase-js"
import { getValidToken } from "./gmail"
import { sendGmailMessage } from "./gmail-send"
import { composePackagePdf } from "./package-pdf"
import { composeCloseoutPackagePdf } from "./closeout-package-pdf"
import { resolveEffectiveSettings } from "./reminder-settings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

export type PackageKind = "submittal" | "closeout"

// Per-type wiring — kept in one table so the shared runner can stay generic.
interface KindConfig {
  packagesTable:  "submittal_packages" | "closeout_packages"
  remindersTable: "submittal_package_reminders" | "closeout_package_reminders"
  composePdf: (supabase: AnySupabase, packageId: string) => Promise<{ bytes: Uint8Array; storagePath: string }>
  pdfFilenamePrefix: string
  subjectLabel: string
  bodyKind: "submittal package" | "closeout package"
  bodyAttachmentLine: string
}

const KIND: Record<PackageKind, KindConfig> = {
  submittal: {
    packagesTable:  "submittal_packages",
    remindersTable: "submittal_package_reminders",
    composePdf: composePackagePdf,
    pdfFilenamePrefix: "Submittal_Package",
    subjectLabel: "Submittal Package",
    bodyKind: "submittal package",
    bodyAttachmentLine: "with your submittal documents attached",
  },
  closeout: {
    packagesTable:  "closeout_packages",
    remindersTable: "closeout_package_reminders",
    composePdf: composeCloseoutPackagePdf,
    pdfFilenamePrefix: "Closeout_Package",
    subjectLabel: "Closeout Package",
    bodyKind: "closeout package",
    bodyAttachmentLine: "with your closeout documents attached (warranties, O&M manuals, certifications, etc.)",
  },
}

// Row shape produced by the SELECT below — every cadence/max/attach column
// is already COALESCEd against company_settings, and sent_count is the
// number of reminders already in the reminders table for this package.
interface DueCandidateRow {
  id:                      string
  project_id:              string
  company_id:              string
  dispatched_at:           string
  dispatched_by:           string | null
  vendor_name_snapshot:    string
  sent_to_email:           string
  gmail_thread_id:         string | null
  package_number:          string
  due_date:                string | null
  effective_cadence:       number[]
  effective_max:           number
  effective_attach:        boolean
  effective_max_reminders: number
  sent_count:              number
}

interface ProjectMeta {
  name:    string | null
  gc_name: string | null
}

function log(step: string, data?: unknown) {
  const payload = data !== undefined ? ` ${JSON.stringify(data)}` : ""
  console.log(`[reminders] ${step}${payload}`)
}

function fmtDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

// ─── Candidate query ────────────────────────────────────────────────────────

/**
 * Return every dispatched-but-not-complete package whose reminders aren't
 * paused, joined with the effective cadence/max/attach values and the count
 * of reminders already sent. The runner then walks each candidate and
 * decides per-row whether *this* tick is the day to send.
 */
async function fetchCandidates(
  supabase: AnySupabase,
  kind: PackageKind,
): Promise<DueCandidateRow[]> {
  const { packagesTable, remindersTable } = KIND[kind]

  // Postgres-side COALESCE keeps the row count small and means the runner
  // never has to look up company_settings separately. The reminders count
  // is a correlated subquery — fine at the small row counts we expect
  // (active dispatched packages per tenant).
  const { data, error } = await supabase
    .from(packagesTable)
    .select(`
      id,
      project_id,
      company_id,
      dispatched_at,
      dispatched_by,
      vendor_name_snapshot,
      sent_to_email,
      gmail_thread_id,
      package_number,
      due_date,
      reminder_cadence_days,
      reminder_max_count,
      reminder_attach_pdf,
      reminders_paused,
      status,
      company_settings:company_id (
        reminder_cadence_days,
        reminder_max_count,
        reminder_default_attach_pdf
      )
    `)
    .in("status", ["dispatched", "partial_received"])
    .eq("reminders_paused", false)
    .not("dispatched_at", "is", null)

  if (error) {
    log("FAIL candidates-query", { kind, error: error.message })
    return []
  }

  // Pull per-package reminder counts in one round-trip and bucket them.
  const pkgIds = (data ?? []).map((r) => (r as { id: string }).id)
  const counts = new Map<string, number>()
  if (pkgIds.length > 0) {
    const { data: rows } = await supabase
      .from(remindersTable)
      .select("package_id")
      .in("package_id", pkgIds)
    for (const r of (rows ?? []) as Array<{ package_id: string }>) {
      counts.set(r.package_id, (counts.get(r.package_id) ?? 0) + 1)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((raw: any): DueCandidateRow => {
    const cs = Array.isArray(raw.company_settings) ? raw.company_settings[0] : raw.company_settings
    // Shared resolver — same code path as the settings GET route, so the
    // cron and UI can never disagree about what's going to run.
    const eff = resolveEffectiveSettings(
      {
        reminder_cadence_days: raw.reminder_cadence_days,
        reminder_max_count:    raw.reminder_max_count,
        reminder_attach_pdf:   raw.reminder_attach_pdf,
        reminders_paused:      raw.reminders_paused,
      },
      cs ?? null,
    )
    return {
      id:                   raw.id,
      project_id:           raw.project_id,
      company_id:           raw.company_id,
      dispatched_at:        raw.dispatched_at,
      dispatched_by:        raw.dispatched_by,
      vendor_name_snapshot: raw.vendor_name_snapshot,
      sent_to_email:        raw.sent_to_email,
      gmail_thread_id:      raw.gmail_thread_id,
      package_number:       raw.package_number,
      due_date:             raw.due_date,
      effective_cadence:       eff.effective_cadence,
      effective_max:           eff.effective_max,
      effective_attach:        eff.effective_attach,
      effective_max_reminders: eff.effective_max_reminders,
      sent_count:              counts.get(raw.id) ?? 0,
    }
  })
}

// ─── Per-package send ───────────────────────────────────────────────────────

interface SendOutcome {
  packageId: string
  status: "sent" | "skipped_not_due" | "skipped_max_reached" | "skipped_no_dispatcher" | "skipped_token_unavailable" | "skipped_already_sent" | "error"
  reminderNumber?: number
  error?: string
}

async function sendOneReminder(
  supabase: AnySupabase,
  kind: PackageKind,
  row: DueCandidateRow,
  project: ProjectMeta,
): Promise<SendOutcome> {
  const cfg = KIND[kind]
  const nextIdx = row.sent_count + 1

  // The cron skips further reminders past the user-configured ceiling. The
  // bound is pre-computed by resolveEffectiveSettings as the same value the
  // UI uses, so a "max reached" decision here can never disagree with the
  // "no more reminders" badge the PM sees on the package detail page.
  if (nextIdx > row.effective_max_reminders) {
    return { packageId: row.id, status: "skipped_max_reached" }
  }

  // The Nth reminder fires when N-th cadence day has elapsed since dispatch.
  // `<=` not `=` so a missed cron tick (Vercel hiccup, env outage) still
  // catches up the next morning rather than skipping a day forever.
  const daysSinceDispatch =
    (Date.now() - new Date(row.dispatched_at).getTime()) / 86_400_000
  const dueAtDay = row.effective_cadence[nextIdx - 1]
  if (daysSinceDispatch < dueAtDay) {
    return { packageId: row.id, status: "skipped_not_due" }
  }

  if (!row.dispatched_by) {
    // No dispatcher → no Gmail connection to send from. Don't silently
    // promote to a service mailbox; surface so the PM can re-dispatch.
    log("skip-no-dispatcher", { kind, packageId: row.id, packageNumber: row.package_number })
    return { packageId: row.id, status: "skipped_no_dispatcher" }
  }

  // Insert the reminder row FIRST as our idempotency lock. A concurrent cron
  // tick that beats us hits UNIQUE(package_id, reminder_number) and gets the
  // 23505 below — we treat that as "another worker handled it" and skip.
  const { data: inserted, error: insertErr } = await supabase
    .from(cfg.remindersTable)
    .insert({
      package_id:       row.id,
      reminder_number:  nextIdx,
      channel:          "gmail",
      attached_pdf:     row.effective_attach,
      company_id:       row.company_id,
    })
    .select("id")
    .single()

  if (insertErr) {
    if (insertErr.code === "23505") {
      return { packageId: row.id, status: "skipped_already_sent", reminderNumber: nextIdx }
    }
    log("FAIL reminder-row-insert", { kind, packageId: row.id, error: insertErr.message, code: insertErr.code })
    return { packageId: row.id, status: "error", error: insertErr.message }
  }

  // Resolve the dispatcher's Gmail token.
  let accessToken: string
  try {
    accessToken = await getValidToken(supabase, row.dispatched_by)
  } catch (err) {
    log("skip-token-unavailable", {
      kind, packageId: row.id, dispatchedBy: row.dispatched_by,
      error: err instanceof Error ? err.message : String(err),
    })
    return { packageId: row.id, status: "skipped_token_unavailable", reminderNumber: nextIdx }
  }

  // Optional: re-attach the original package PDF. Cheaper to rebuild than to
  // add a download-from-storage path here — composePackagePdf already runs
  // in the dispatch route's hot path.
  const attachments: Array<{ filename: string; mimeType: string; content: Uint8Array }> = []
  if (row.effective_attach) {
    try {
      const { bytes } = await cfg.composePdf(supabase, row.id)
      attachments.push({
        filename: `${cfg.pdfFilenamePrefix}_${row.package_number}.pdf`,
        mimeType: "application/pdf",
        content:  bytes,
      })
    } catch (err) {
      // PDF rebuild failure shouldn't block a text reminder — log + send
      // text-only. (Mark the row as text-only so the audit reflects reality.)
      log("FAIL compose-pdf-fallback-text-only", {
        kind, packageId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
      await supabase
        .from(cfg.remindersTable)
        .update({ attached_pdf: false })
        .eq("id", inserted.id)
    }
  }

  const subject = (row.gmail_thread_id ? "Re: " : "") +
    `${cfg.subjectLabel} reminder — ${project.name ?? "Project"} — [${row.package_number}]`

  const itemsRemainingLine = `Items still expected — please reply ${cfg.bodyAttachmentLine}.`
  const dueLine = row.due_date ? fmtDate(row.due_date) : "Per project schedule"
  const bodyText = [
    `Hi ${row.vendor_name_snapshot},`,
    "",
    `Friendly reminder: the ${cfg.bodyKind} for ${project.name ?? "this project"} dispatched`,
    `on ${fmtDate(row.dispatched_at)} is still showing items pending on our end.`,
    "",
    itemsRemainingLine,
    `Due date: ${dueLine}`,
    "",
    "If you've already returned these, please disregard this message. Otherwise",
    "reply to this email — your response will route back to this package",
    "automatically using the tracking reference below.",
    "",
    `Tracking ref: [${row.package_number}]`,
    "",
    `— ${project.gc_name ?? "the General Contractor"}`,
  ].join("\n")

  let sent: { id: string; threadId: string }
  try {
    sent = await sendGmailMessage(accessToken, {
      to:        row.sent_to_email,
      subject,
      bodyText,
      attachments: attachments.length > 0 ? attachments : undefined,
      threadId:  row.gmail_thread_id ?? undefined,
    })
  } catch (err) {
    log("FAIL gmail-send", {
      kind, packageId: row.id,
      error: err instanceof Error ? err.message : String(err),
    })
    // Leave the reminder row in place — see file-top idempotency note.
    return {
      packageId: row.id, status: "error", reminderNumber: nextIdx,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  await supabase
    .from(cfg.remindersTable)
    .update({ gmail_message_id: sent.id })
    .eq("id", inserted.id)

  log("sent", { kind, packageId: row.id, reminderNumber: nextIdx, gmailId: sent.id })
  return { packageId: row.id, status: "sent", reminderNumber: nextIdx }
}

// ─── Public entrypoint ─────────────────────────────────────────────────────

export interface RunReport {
  kind: PackageKind
  candidates: number
  sent: number
  skipped_not_due: number
  skipped_max_reached: number
  skipped_no_dispatcher: number
  skipped_token_unavailable: number
  skipped_already_sent: number
  errors: number
  errorMessages: string[]
}

/**
 * Find every reminder due for a package type and send them. Idempotent — safe
 * to invoke multiple times in the same day.
 */
export async function runRemindersForKind(
  supabase: AnySupabase,
  kind: PackageKind,
): Promise<RunReport> {
  const candidates = await fetchCandidates(supabase, kind)
  log("candidates", { kind, count: candidates.length })

  const report: RunReport = {
    kind, candidates: candidates.length,
    sent: 0, skipped_not_due: 0, skipped_max_reached: 0,
    skipped_no_dispatcher: 0, skipped_token_unavailable: 0,
    skipped_already_sent: 0, errors: 0, errorMessages: [],
  }

  // Cache project lookups across the loop — many packages per project.
  const projectCache = new Map<string, ProjectMeta>()

  for (const row of candidates) {
    let project = projectCache.get(row.project_id)
    if (!project) {
      const { data } = await supabase
        .from("projects").select("name, gc_name").eq("id", row.project_id).maybeSingle()
      project = {
        name:    (data?.name as string | null) ?? null,
        gc_name: (data?.gc_name as string | null) ?? null,
      }
      projectCache.set(row.project_id, project)
    }

    const outcome = await sendOneReminder(supabase, kind, row, project)
    switch (outcome.status) {
      case "sent":                       report.sent++; break
      case "skipped_not_due":            report.skipped_not_due++; break
      case "skipped_max_reached":        report.skipped_max_reached++; break
      case "skipped_no_dispatcher":      report.skipped_no_dispatcher++; break
      case "skipped_token_unavailable":  report.skipped_token_unavailable++; break
      case "skipped_already_sent":       report.skipped_already_sent++; break
      case "error":
        report.errors++
        if (outcome.error) report.errorMessages.push(`${row.package_number}: ${outcome.error}`)
        break
    }
  }

  log("done", report)
  return report
}
