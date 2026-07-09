import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  composeTransmittalPackagePdf,
  type RecipientType, type CoversheetMode,
} from "@/lib/package-pdf"

export const maxDuration = 60

// ─── Submittal packages — collection (Session I) ────────────────────────────
// GET  /api/submittal-packages?project_id=…  — list packages for a project,
//        each with item_count / received_count / needs_review_count aggregates.
// POST /api/submittal-packages               — create a draft package.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pkg = Record<string, any>

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = new URL(req.url).searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data: packages, error } = await supabase
    .from("submittal_packages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const pkgList = (packages ?? []) as Pkg[]
  const ids = pkgList.map(p => p.id)
  if (ids.length === 0) return NextResponse.json({ packages: [] })

  // Items per package + received state of each linked submittal.
  const { data: items } = await supabase
    .from("submittal_package_items")
    .select("package_id, submittal_id, submittals(received_date)")
    .in("package_id", ids)

  // Inbound replies tagged to these packages — orphans (not a package item)
  // are the "needs review" responses match-back could not auto-link.
  const { data: inbound } = await supabase
    .from("submittals")
    .select("id, received_via_package_id")
    .in("received_via_package_id", ids)
    .eq("status", "active")
    .is("deleted_at", null)

  const itemCount = new Map<string, number>()
  const receivedCount = new Map<string, number>()
  const itemSubmittalIds = new Set<string>()
  for (const it of (items ?? []) as Pkg[]) {
    itemCount.set(it.package_id, (itemCount.get(it.package_id) ?? 0) + 1)
    itemSubmittalIds.add(it.submittal_id)
    if (it.submittals?.received_date) {
      receivedCount.set(it.package_id, (receivedCount.get(it.package_id) ?? 0) + 1)
    }
  }

  const needsReviewCount = new Map<string, number>()
  for (const row of (inbound ?? []) as Pkg[]) {
    if (itemSubmittalIds.has(row.id)) continue // auto-linked, not orphaned
    needsReviewCount.set(row.received_via_package_id, (needsReviewCount.get(row.received_via_package_id) ?? 0) + 1)
  }

  return NextResponse.json({
    packages: pkgList.map(p => ({
      ...p,
      item_count: itemCount.get(p.id) ?? 0,
      received_count: receivedCount.get(p.id) ?? 0,
      needs_review_count: needsReviewCount.get(p.id) ?? 0,
    })),
  })
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The recipient type decides which submittal date column gets stamped:
//   cm  → sent_to_ae_date  (the CM is the conduit to the A/E — same upstream hop)
//   ae  → sent_to_ae_date
//   subcontractor → sent_to_sub_date
const DATE_COLUMN: Record<RecipientType, "sent_to_ae_date" | "sent_to_sub_date"> = {
  cm: "sent_to_ae_date",
  ae: "sent_to_ae_date",
  subcontractor: "sent_to_sub_date",
}

// POST /api/submittal-packages — assemble a TRANSMITTAL package.
//
// A package = selected submittal log rows + a recipient type + a send date + a
// coversheet mode. On create we compose the transmittal PDF (the actual
// approved documents, not spec pages), store it, and — unless saving a draft —
// stamp the chosen date column on every packaged submittal. Creating the
// package IS the send event; the PM sends the downloaded PDF from their own
// email client. There is no dispatch/email action.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const {
    project_id, recipient_type, send_date, coversheet_mode,
    notes, submittal_ids, is_draft,
  } = body as {
    project_id?: string
    recipient_type?: string
    send_date?: string
    coversheet_mode?: string
    notes?: string | null
    submittal_ids?: string[]
    is_draft?: boolean
  }

  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (recipient_type !== "cm" && recipient_type !== "ae" && recipient_type !== "subcontractor") {
    return NextResponse.json({ error: "Choose who this is being sent to (CM, A/E, or Subcontractor)" }, { status: 400 })
  }
  if (coversheet_mode !== "per_item" && coversheet_mode !== "package") {
    return NextResponse.json({ error: "Choose a coversheet mode" }, { status: 400 })
  }
  const sendDate = (send_date ?? "").trim()
  if (!DATE_RE.test(sendDate) || Number.isNaN(new Date(`${sendDate}T00:00:00`).getTime())) {
    return NextResponse.json({ error: "A valid send date is required" }, { status: 400 })
  }
  if (!Array.isArray(submittal_ids) || submittal_ids.length === 0) {
    return NextResponse.json({ error: "Select at least one submittal to package" }, { status: 400 })
  }
  const recipientType = recipient_type as RecipientType
  const coversheetMode = coversheet_mode as CoversheetMode

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 403 })

  // All submittals must belong to the target project (no cross-project packages).
  const { data: subRows, error: subErr } = await supabase
    .from("submittals")
    .select("id")
    .in("id", submittal_ids)
    .eq("project_id", project_id)
    .eq("status", "active")
  if (subErr) return NextResponse.json({ error: subErr.message }, { status: 500 })
  const valid = new Set((subRows ?? []).map(r => r.id))
  // Preserve the caller's selection order for the appended documents.
  const validIds = submittal_ids.filter(id => valid.has(id))
  if (validIds.length === 0) {
    return NextResponse.json({ error: "None of the selected submittals belong to this project" }, { status: 400 })
  }

  // Allocate the per-project package number → TTQ-{short_id}-{seq}.
  const { data: projectRow, error: projErr } = await supabase
    .from("projects")
    .select("short_id")
    .eq("id", project_id)
    .maybeSingle()
  if (projErr || !projectRow) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  const { data: seq, error: seqErr } = await supabase.rpc("next_package_seq", { p_project_id: project_id })
  if (seqErr || typeof seq !== "number") {
    return NextResponse.json({ error: seqErr?.message ?? "Could not allocate a package number" }, { status: 500 })
  }
  const shortId = projectRow.short_id || project_id.replace(/-/g, "").slice(0, 4).toUpperCase()
  const packageNumber = `TTQ-${shortId}-${seq}`

  const draft = is_draft === true

  // Transmittal facts live in dedicated columns (migration 0036):
  //   recipient_type  — who it went to (decides which date column is stamped)
  //   coversheet_mode — how the PDF was assembled
  //   send_date       — the send date; NULL on an unsent draft
  // The legacy solicitation columns (vendor_name_snapshot / sent_to_email) are
  // NOT NULL but unused by transmittals, so they're stored empty until the
  // follow-up cleanup migration drops them. status defaults to 'draft', which
  // keeps transmittals OUT of the reminder cron (its candidate query requires
  // status IN ('dispatched','partial_received')). No dispatched_at / dispatched_by
  // / reminders_paused overload.
  const { data: pkg, error: insErr } = await supabase
    .from("submittal_packages")
    .insert({
      project_id,
      package_number: packageNumber,
      recipient_type: recipientType,
      coversheet_mode: coversheetMode,
      send_date: draft ? null : sendDate,
      notes: notes?.trim() || null,
      created_by: user.id,
      vendor_name_snapshot: "",
      sent_to_email: "",
    })
    .select()
    .single()
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  const { error: itemErr } = await supabase
    .from("submittal_package_items")
    .insert(validIds.map(sid => ({ package_id: pkg.id, submittal_id: sid })))
  if (itemErr) {
    // Roll back the package so we don't leave an empty row behind.
    await supabase.from("submittal_packages").delete().eq("id", pkg.id)
    return NextResponse.json({ error: itemErr.message }, { status: 500 })
  }

  // Compose the transmittal PDF (approved documents) and store it. A failure
  // here rolls the whole package back — a package with no PDF is useless.
  let pdfPath: string
  let warnings: string[] = []
  try {
    const res = await composeTransmittalPackagePdf(supabase, {
      packageId: pkg.id,
      projectId: project_id,
      companyId,
      packageNumber,
      recipientType,
      sendDate,
      coversheetMode,
      submittalIds: validIds,
    })
    pdfPath = res.storagePath
    warnings = res.warnings
  } catch (err) {
    await supabase.from("submittal_packages").delete().eq("id", pkg.id)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build the package PDF" },
      { status: 500 },
    )
  }
  await supabase.from("submittal_packages").update({ pdf_file_path: pdfPath }).eq("id", pkg.id)

  // ── Date stamp — the one write to live submittal rows. Sending upstream (or
  //    to a sub) stamps the corresponding date column; re-packaging OVERWRITES
  //    it (most-recent-send wins). Nothing else on the row changes. Authed
  //    client only — RLS scopes the update to the caller's company. Skipped for
  //    a draft (an unsent, assembled package).
  //
  //    KNOWN INTERACTION (documented, accepted): sent_to_ae_date is ALSO synced
  //    from the current attachment's submitted_date by the
  //    submittal_attachments_sync_current_aiu trigger. Committing a NEW revision
  //    for a packaged submittal re-fires that trigger and overwrites this stamp
  //    with the new revision's submitted_date (or NULL if it has none). A new
  //    revision is a new submission cycle, so that's acceptable — but it means a
  //    CM/A/E stamp is not permanent across revisions. sent_to_sub_date is never
  //    touched by that trigger, so subcontractor stamps are stable. ──────────
  if (!draft) {
    const column = DATE_COLUMN[recipientType]
    const { error: stampErr } = await supabase
      .from("submittals")
      .update({ [column]: sendDate })
      .in("id", validIds)
    if (stampErr) {
      // The package + PDF already exist; surface the stamp failure but don't
      // orphan the package. The PM can re-send to retry the stamp.
      return NextResponse.json(
        { error: `Package created, but stamping ${column} failed: ${stampErr.message}` },
        { status: 500 },
      )
    }
  }

  // Signed URL so the modal can preview immediately without a second round-trip.
  const { data: signed } = await supabase.storage
    .from("submittals")
    .createSignedUrl(pdfPath, 60 * 60)

  return NextResponse.json(
    { package: { ...pkg, pdf_file_path: pdfPath, item_count: validIds.length }, url: signed?.signedUrl ?? null, warnings },
    { status: 201 },
  )
}
