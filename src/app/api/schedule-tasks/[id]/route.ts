import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { deriveDurationDays, scheduleTaskCheckMessage } from "@/lib/schedule/api"

// ── Schedule task — edit + soft-delete (Phase 3, Slice 2) ────────────────────
// Standard cookie server client; RLS scopes every read/write to the caller's
// company. PATCH is a plain UPDATE over an explicit allow-list — it NEVER touches
// deleted_at, so the post-update row still satisfies the deleted_at-IS-NULL SELECT
// policy. DELETE soft-deletes via the SECURITY DEFINER RPC — never a bare
// deleted_at UPDATE (the 42501 RLS trap). company_id/created_by are never
// re-resolved from the client.

const TASK_COLS =
  "id, project_id, name, phase, start_date, end_date, is_milestone, duration_days, voided_dates, " +
  "percent_complete, actual_start_date, actual_end_date, sort_order, wbs_code, status, crew_size, notes, created_at, created_by"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// 'backlog' added (matches the POST route + the DB status CHECK as of migration 0023):
// a backlog row may be dateless, so it relaxes the date-presence rule below.
const STATUSES = ["not_started", "in_progress", "complete", "backlog"] as const

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// PATCH /api/schedule-tasks/[id] — edit from an explicit allow-list:
// name, phase, start_date, end_date, is_milestone, percent_complete, status,
// crew_size, voided_dates, wbs_code, sort_order, notes, actual_start_date,
// actual_end_date.
// Dates are conditionally optional: a 'backlog' row may be dateless, so the route
// supports BOTH scheduling a backlog task (set both dates + a dated status) and
// sending one back to the backlog (status='backlog' + null dates). When the patch
// touches the bar geometry or the status we (a) enforce the date-presence invariant
// (both dates OR status='backlog') for a clean 400, and (b) recompute the cached
// duration_days from the resulting bar — null for a dateless backlog row — so it can't
// drift from the dates. The DB CHECKs (date order / pct / status / presence) validate
// the final row and map to clean 400s.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if ("name" in body) {
    const v = strOrNull(body.name)
    if (!v) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 })
    patch.name = v
  }
  if ("phase" in body) patch.phase = strOrNull(body.phase)
  if ("wbs_code" in body) patch.wbs_code = strOrNull(body.wbs_code)
  if ("notes" in body) patch.notes = strOrNull(body.notes)

  // start_date/end_date may be CLEARED (null) — but only when the FINAL status is
  // 'backlog' (enforced after we know the resulting row, below). A PRESENT value must
  // still be a valid YYYY-MM-DD (a malformed date is a 400, never a silent null),
  // mirroring the POST route's conditional-date contract. Keep the strict behavior for
  // dated statuses via the presence check below.
  for (const k of ["start_date", "end_date"] as const) {
    if (k in body) {
      const v = strOrNull(body[k])
      if (v && !DATE_RE.test(v)) return NextResponse.json({ error: `${k} must be YYYY-MM-DD` }, { status: 400 })
      patch[k] = v // null = clear; presence validated against the final status below
    }
  }
  // actual_* may be cleared by sending null/"" → strOrNull collapses to null.
  for (const k of ["actual_start_date", "actual_end_date"] as const) {
    if (k in body) {
      const v = strOrNull(body[k])
      if (v && !DATE_RE.test(v)) return NextResponse.json({ error: `${k} must be YYYY-MM-DD` }, { status: 400 })
      patch[k] = v
    }
  }

  if ("is_milestone" in body) {
    if (typeof body.is_milestone !== "boolean") return NextResponse.json({ error: "is_milestone must be a boolean" }, { status: 400 })
    patch.is_milestone = body.is_milestone
  }
  if ("percent_complete" in body) {
    const raw = body.percent_complete
    const n = Number(raw)
    if (raw === "" || !Number.isInteger(n) || n < 0 || n > 100) {
      return NextResponse.json({ error: "percent_complete must be a whole number 0–100" }, { status: 400 })
    }
    patch.percent_complete = n
  }
  if ("status" in body) {
    if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) {
      return NextResponse.json({ error: "status must be not_started, in_progress, complete, or backlog" }, { status: 400 })
    }
    patch.status = body.status
  }
  if ("sort_order" in body) {
    const n = Number(body.sort_order)
    if (!Number.isInteger(n)) return NextResponse.json({ error: "sort_order must be a whole number" }, { status: 400 })
    patch.sort_order = n
  }
  // crew_size: optional non-negative whole number; null/"" clears it (mirrors POST).
  if ("crew_size" in body) {
    const raw = body.crew_size
    if (raw === null || raw === "") {
      patch.crew_size = null
    } else {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0) return NextResponse.json({ error: "crew_size must be a whole number ≥ 0" }, { status: 400 })
      patch.crew_size = n
    }
  }
  // voided_dates: the planning-board's per-day non-working overrides (migration 0024:
  // date[] NOT NULL DEFAULT '{}'). Must be an ARRAY of valid YYYY-MM-DD strings; a
  // non-array or any malformed element is a 400. An empty array is allowed and CLEARS
  // all voids. Deduped here so the stored array stays clean (the duration math dedupes
  // too). A voided day outside the bar is accepted and simply ignored by the duration
  // recompute below — it costs nothing and lets a future resize re-activate it.
  if ("voided_dates" in body) {
    const v = body.voided_dates
    if (!Array.isArray(v)) {
      return NextResponse.json({ error: "voided_dates must be an array of YYYY-MM-DD strings" }, { status: 400 })
    }
    const seen = new Set<string>()
    const out: string[] = []
    for (const el of v) {
      if (typeof el !== "string" || !DATE_RE.test(el)) {
        return NextResponse.json({ error: "voided_dates entries must each be YYYY-MM-DD" }, { status: 400 })
      }
      if (!seen.has(el)) { seen.add(el); out.push(el) }
    }
    patch.voided_dates = out
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }

  // When the patch touches the bar geometry OR the status, validate the resulting row
  // against the DB's date-presence invariant (both dates present OR status='backlog')
  // and recompute the cached duration_days from the FINAL bar. A single-field edit
  // needs the unchanged fields, so pre-fetch the current row (RLS-scoped maybeSingle →
  // 404 if not visible). We branch on "x in patch" (validated/accepted fields), never
  // raw "x in body".
  if (
    "start_date" in patch || "end_date" in patch ||
    "is_milestone" in patch || "status" in patch || "voided_dates" in patch
  ) {
    const { data: current } = await supabase
      .from("schedule_tasks")
      .select("start_date, end_date, is_milestone, status, voided_dates")
      .eq("id", id)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: "Task not found" }, { status: 404 })

    const finalStart = ("start_date" in patch ? patch.start_date : current.start_date) as string | null
    const finalEnd = ("end_date" in patch ? patch.end_date : current.end_date) as string | null
    const finalMilestone = ("is_milestone" in patch ? patch.is_milestone : current.is_milestone) as boolean
    const finalStatus = ("status" in patch ? patch.status : current.status) as string
    // The voids that drive the recompute: the patched array if present, else the row's
    // current array (date[] NOT NULL → always an array, but guard to [] defensively).
    const finalVoided = (("voided_dates" in patch ? patch.voided_dates : current.voided_dates) ?? []) as string[]

    // Date-presence invariant — mirrors the DB CHECK (both dates OR status='backlog').
    // Only a backlog row may be dateless; any dated status requires BOTH endpoints.
    // Caught here for a clean 400 before the round trip; the CHECK is the backstop.
    if (finalStatus !== "backlog" && (!finalStart || !finalEnd)) {
      return NextResponse.json(
        { error: "start_date and end_date are required unless status is backlog" },
        { status: 400 },
      )
    }

    // Cached duration only when both dates exist; a dateless backlog row has no span,
    // so duration_days is null (deriveDurationDays would deref a null date otherwise).
    // When dated, the final voids subtract from the working-day span so a voided in-span
    // day drops the duration by one. Voids on a dateless backlog row stay stored but
    // don't affect duration (it's null) — they apply once the row is scheduled.
    patch.duration_days = finalStart && finalEnd
      ? deriveDurationDays(finalStart, finalEnd, finalMilestone, finalVoided)
      : null
  }

  // .maybeSingle() doubles as the tenant/existence check: RLS limits the UPDATE to
  // this company's live rows, so a cross-company or soft-deleted id updates 0 rows
  // → null → 404.
  const { data, error } = await supabase
    .from("schedule_tasks")
    .update(patch)
    .eq("id", id)
    .select(TASK_COLS)
    .maybeSingle()

  if (error) {
    const friendly = scheduleTaskCheckMessage(error)
    if (friendly) return NextResponse.json({ error: friendly }, { status: 400 })
    console.error("Failed to update schedule task:", error)
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: "Task not found" }, { status: 404 })
  return NextResponse.json({ task: data })
}

// DELETE /api/schedule-tasks/[id] — SOFT delete via the soft_delete_schedule_task
// SECURITY DEFINER RPC (migration 0022), company-scoped internally via
// get_my_company_id(). NOT a bare UPDATE deleted_at (which would fall outside the
// deleted_at-IS-NULL policy and be rejected 42501). The RPC returns the id on
// success, or no row if not found / cross-company / already deleted → 404. Edges
// touching the task remain rows but the task drops from the RLS-scoped GET; a hard
// task delete (not done here) would CASCADE the edges via the FK.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data: deletedId, error } = await supabase.rpc("soft_delete_schedule_task", { p_id: id })
  if (error) {
    console.error("Failed to soft-delete schedule task:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!deletedId) return NextResponse.json({ error: "Task not found or already deleted" }, { status: 404 })
  return NextResponse.json({ ok: true, id })
}
