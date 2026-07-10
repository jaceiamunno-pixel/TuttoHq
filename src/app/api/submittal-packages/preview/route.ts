import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  resolvePackageItems, buildTransmittalPackageFiles,
  type RecipientType, type CoversheetMode,
} from "@/lib/package-pdf"

export const maxDuration = 60

// ─── Transmittal-package PREVIEW (read-only, gates generation) ──────────────
// POST /api/submittal-packages/preview
//
// Resolves EXACTLY the cover data the real generation will use (same
// resolvePackageItems path), so the user reviews/edits the cover BEFORE
// anything is assembled, stored, or date-stamped. This endpoint:
//   • creates NO submittal_packages row, NO submittal_package_items, and NO
//     submittal_package_files rows,
//   • stamps NO date column on any submittal,
//   • allocates NO package number (that write happens only on real create).
// It is purely a resolver + (for 'package' mode) an in-memory cover render.
//
// The reviewer stamp identity is resolved SERVER-SIDE inside resolvePackageItems
// from the caller's own session — never from the request body.
//
//   'per_item' → returns per-item coversheet props + the (display-only)
//                reviewer, which the modal renders as the editable HTML cover.
//   'package'  → returns the ACTUAL summary cover rendered to a cover-only PDF
//                (base64), plus each item's editable description.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const {
    project_id, recipient_type, send_date, coversheet_mode, submittal_ids,
  } = body as {
    project_id?: string
    recipient_type?: string
    send_date?: string
    coversheet_mode?: string
    submittal_ids?: string[]
  }

  // Validate the same shape as the real create (minus draft) — the preview must
  // reject anything the create would reject, so "looks fine in preview" never
  // means "fails on create".
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

  // All submittals must belong to the target project (no cross-project preview),
  // preserving the caller's selection order.
  const { data: subRows, error: subErr } = await supabase
    .from("submittals")
    .select("id")
    .in("id", submittal_ids)
    .eq("project_id", project_id)
    .eq("status", "active")
  if (subErr) return NextResponse.json({ error: subErr.message }, { status: 500 })
  const valid = new Set((subRows ?? []).map(r => r.id))
  const validIds = submittal_ids.filter(id => valid.has(id))
  if (validIds.length === 0) {
    return NextResponse.json({ error: "None of the selected submittals belong to this project" }, { status: 400 })
  }

  // Resolve cover data — NO document downloads (cover-only preview), NO writes.
  const resolved = await resolvePackageItems(
    supabase,
    { projectId: project_id, companyId, sendDate, submittalIds: validIds, userId: user.id },
    { withDocuments: false },
  )

  if (coversheetMode === "per_item") {
    return NextResponse.json({
      mode: "per_item",
      items: resolved.items.map(it => ({
        submittalId: it.submittalId,
        coversheet: it.coversheet,
        // Display-only. Generation re-resolves this server-side and ignores any
        // client value, so tampering with it here cannot change what is stamped.
        reviewer: it.reviewer,
      })),
    })
  }

  // 'package' — render the ACTUAL summary cover (cover only; documentBytes are
  // null so nothing is appended). The package number is allocated only on real
  // create, so the preview shows a clearly-pending tracking ref.
  const { data: projectRow } = await supabase
    .from("projects").select("short_id").eq("id", project_id).maybeSingle()
  const shortId = projectRow?.short_id || project_id.replace(/-/g, "").slice(0, 4).toUpperCase()
  const pendingNumber = `TTQ-${shortId}-#`

  const built = await buildTransmittalPackageFiles({
    packageNumber: pendingNumber,
    recipientType,
    sendDate,
    coversheetMode: "package",
    project: resolved.project,
    gcName: resolved.gcName,
    logoBytes: resolved.logoBytes,
    logoScalePct: resolved.logoScalePct,
    items: resolved.items,
  })

  const coverPdfBase64 = built[0] ? Buffer.from(built[0].bytes).toString("base64") : null

  return NextResponse.json({
    mode: "package",
    pendingNumber,
    coverPdfBase64,
    // The one descriptive field that appears on the summary cover (items table).
    items: resolved.items.map(it => ({
      submittalId: it.submittalId,
      description: it.description,
    })),
  })
}
