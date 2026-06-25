import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveEffectiveSettings, computeNextDueAt } from "@/lib/reminder-settings"

// ─── Submittal package — single resource (Session I) ────────────────────────
// GET    /api/submittal-packages/[id]  — package + expected items + inbound
//          replies awaiting PM review (orphans match-back could not auto-link).
// PATCH  /api/submittal-packages/[id]  — edit a draft (scalar fields + items).
// DELETE /api/submittal-packages/[id]  — delete the package.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: pkg, error } = await supabase
    .from("submittal_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })

  // Expected items — the submittals the sub must produce.
  const { data: itemRows } = await supabase
    .from("submittal_package_items")
    .select("submittal_id, submittals(*)")
    .eq("package_id", id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (itemRows ?? []).map((r: any) => r.submittals).filter(Boolean)
  items.sort((a: { submittal_seq: number | null }, b: { submittal_seq: number | null }) =>
    (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
  const itemIds = new Set(items.map((s: { id: string }) => s.id))

  // Inbound replies tagged to this package. Those that are NOT an expected
  // item are the "needs review" responses match-back could not auto-link.
  const { data: inboundRows } = await supabase
    .from("submittals")
    .select("*")
    .eq("received_via_package_id", id)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("received_at", { ascending: false })
  const needsReview = (inboundRows ?? []).filter((s: { id: string }) => !itemIds.has(s.id))

  // Reminder settings + observability — joins company defaults via the
  // shared resolver so the UI's "effective" display can never disagree with
  // the cron's actual behavior (see src/lib/reminder-settings.ts).
  const [companyRes, remindersRes] = await Promise.all([
    supabase.from("company_settings")
      .select("reminder_cadence_days, reminder_max_count, reminder_default_attach_pdf")
      .maybeSingle(),
    supabase.from("submittal_package_reminders")
      .select("sent_at")
      .eq("package_id", id)
      .order("sent_at", { ascending: false }),
  ])
  const effective = resolveEffectiveSettings(
    {
      reminder_cadence_days: pkg.reminder_cadence_days ?? null,
      reminder_max_count:    pkg.reminder_max_count ?? null,
      reminder_attach_pdf:   pkg.reminder_attach_pdf ?? null,
      reminders_paused:      pkg.reminders_paused ?? false,
    },
    companyRes.data ?? null,
  )
  const reminderRows = (remindersRes.data ?? []) as Array<{ sent_at: string }>
  const sentCount = reminderRows.length
  const lastSentAt = reminderRows[0]?.sent_at ?? null
  const nextDueAt = computeNextDueAt(
    pkg.dispatched_at ?? null,
    sentCount,
    pkg.reminders_paused ?? false,
    effective,
  )

  return NextResponse.json({
    package: {
      ...pkg,
      item_count: items.length,
      received_count: items.filter((s: { received_date: string | null }) => !!s.received_date).length,
      needs_review_count: needsReview.length,
      items,
      needs_review: needsReview,
      reminder_settings: {
        effective_cadence:        effective.effective_cadence,
        effective_max:            effective.effective_max,
        effective_attach:         effective.effective_attach,
        effective_max_reminders:  effective.effective_max_reminders,
        sent_count:               sentCount,
        last_sent_at:             lastSentAt,
        next_due_at:              nextDueAt,
      },
    },
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const { data: pkg } = await supabase
    .from("submittal_packages")
    .select("id, status, project_id")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })
  if (pkg.status !== "draft") {
    return NextResponse.json({ error: "Only draft packages can be edited" }, { status: 409 })
  }

  // Scalar field updates
  const updates: Record<string, unknown> = {}
  if ("due_date" in body) updates.due_date = body.due_date || null
  if ("notes" in body) updates.notes = (body.notes as string)?.trim() || null
  if ("sent_to_email" in body) {
    const email = (body.sent_to_email as string)?.trim()
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid recipient email is required" }, { status: 400 })
    }
    updates.sent_to_email = email
  }
  if ("vendor_name" in body) {
    const name = (body.vendor_name as string)?.trim()
    if (!name) return NextResponse.json({ error: "A vendor name is required" }, { status: 400 })
    updates.vendor_name_snapshot = name
  }
  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from("submittal_packages").update(updates).eq("id", id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Optional full replacement of the item set.
  if (Array.isArray(body.submittal_ids)) {
    const ids: string[] = body.submittal_ids
    if (ids.length === 0) {
      return NextResponse.json({ error: "A package must contain at least one submittal" }, { status: 400 })
    }
    const { data: subRows } = await supabase
      .from("submittals")
      .select("id")
      .in("id", ids)
      .eq("project_id", pkg.project_id)
      .eq("status", "active")
    const validIds = (subRows ?? []).map(r => r.id)
    if (validIds.length === 0) {
      return NextResponse.json({ error: "None of the selected submittals belong to this project" }, { status: 400 })
    }
    await supabase.from("submittal_package_items").delete().eq("package_id", id)
    const { error: itemErr } = await supabase
      .from("submittal_package_items")
      .insert(validIds.map(sid => ({ package_id: id, submittal_id: sid })))
    if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  // Items cascade; submittals.received_via_package_id is ON DELETE SET NULL.
  const { error } = await supabase.from("submittal_packages").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
