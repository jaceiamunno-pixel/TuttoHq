import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveEffectiveSettings, computeNextDueAt } from "@/lib/reminder-settings"

// ─── Closeout package — single resource (Session K1) ────────────────────────
// GET    /api/closeout-packages/[id]  — package + expected items + pending
//          inbound replies awaiting PM placement.
// PATCH  /api/closeout-packages/[id]  — edit a draft (scalar fields + items).
// DELETE /api/closeout-packages/[id]  — delete the package.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: pkg, error } = await supabase
    .from("closeout_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })

  // Expected items — the closeout_items the sub must return.
  const { data: itemRows } = await supabase
    .from("closeout_package_items")
    .select("closeout_item_id, closeout_items(*)")
    .eq("package_id", id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (itemRows ?? []).map((r: any) => r.closeout_items).filter(Boolean)
  items.sort((a: { sort_order: number | null }, b: { sort_order: number | null }) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0))

  // Pending inbound replies — PM must place each one against an expected item.
  const { data: inboundRows } = await supabase
    .from("closeout_package_inbound")
    .select("*")
    .eq("package_id", id)
    .eq("status", "pending")
    .order("received_at", { ascending: false })

  const itemArr = items as Array<{ status: string | null }>

  // Reminder settings + observability — shared resolver, see notes in
  // src/lib/reminder-settings.ts.
  const [companyRes, remindersRes] = await Promise.all([
    supabase.from("company_settings")
      .select("reminder_cadence_days, reminder_max_count, reminder_default_attach_pdf")
      .maybeSingle(),
    supabase.from("closeout_package_reminders")
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
      item_count: itemArr.length,
      received_count: itemArr.filter(s => s.status === "complete").length,
      needs_review_count: (inboundRows ?? []).length,
      items,
      needs_review: inboundRows ?? [],
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
    .from("closeout_packages")
    .select("id, status, project_id")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })
  if (pkg.status !== "draft") {
    return NextResponse.json({ error: "Only draft packages can be edited" }, { status: 409 })
  }

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
    const { error } = await supabase.from("closeout_packages").update(updates).eq("id", id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (Array.isArray(body.closeout_item_ids)) {
    const ids: string[] = body.closeout_item_ids
    if (ids.length === 0) {
      return NextResponse.json({ error: "A package must contain at least one item" }, { status: 400 })
    }
    const { data: itemRows } = await supabase
      .from("closeout_items")
      .select("id")
      .in("id", ids)
      .eq("project_id", pkg.project_id)
    const validIds = (itemRows ?? []).map(r => r.id)
    if (validIds.length === 0) {
      return NextResponse.json({ error: "None of the selected items belong to this project" }, { status: 400 })
    }
    await supabase.from("closeout_package_items").delete().eq("package_id", id)
    const { error: junctionErr } = await supabase
      .from("closeout_package_items")
      .insert(validIds.map(cid => ({ package_id: id, closeout_item_id: cid })))
    if (junctionErr) return NextResponse.json({ error: junctionErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  // Items + inbound cascade via ON DELETE CASCADE.
  const { error } = await supabase.from("closeout_packages").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
