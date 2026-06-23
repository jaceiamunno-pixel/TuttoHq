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
  "id, project_id, name, phase, start_date, end_date, is_milestone, duration_days, " +
  "percent_complete, actual_start_date, actual_end_date, sort_order, wbs_code, status, notes, created_at, created_by"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STATUSES = ["not_started", "in_progress", "complete"] as const

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// PATCH /api/schedule-tasks/[id] — edit from an explicit allow-list:
// name, phase, start_date, end_date, is_milestone, percent_complete, status,
// wbs_code, sort_order, notes, actual_start_date, actual_end_date. When any of
// start_date/end_date/is_milestone change we recompute the cached duration_days
// from the resulting bar (a pre-fetch supplies the unchanged endpoints) so it can't
// drift from the dates. The DB CHECKs (date order / pct / status) validate the
// final row and map to clean 400s.
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

  for (const k of ["start_date", "end_date"] as const) {
    if (k in body) {
      const v = strOrNull(body[k])
      if (!v || !DATE_RE.test(v)) return NextResponse.json({ error: `${k} must be YYYY-MM-DD` }, { status: 400 })
      patch[k] = v
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
      return NextResponse.json({ error: "status must be not_started, in_progress, or complete" }, { status: 400 })
    }
    patch.status = body.status
  }
  if ("sort_order" in body) {
    const n = Number(body.sort_order)
    if (!Number.isInteger(n)) return NextResponse.json({ error: "sort_order must be a whole number" }, { status: 400 })
    patch.sort_order = n
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }

  // If the bar geometry changed, recompute the cached duration_days from the FINAL
  // start/end/is_milestone. A single-endpoint edit needs the unchanged endpoints,
  // so pre-fetch the current row (RLS-scoped maybeSingle → 404 if not visible).
  if ("start_date" in patch || "end_date" in patch || "is_milestone" in patch) {
    const { data: current } = await supabase
      .from("schedule_tasks")
      .select("start_date, end_date, is_milestone")
      .eq("id", id)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: "Task not found" }, { status: 404 })
    const start_date = (patch.start_date as string) ?? current.start_date
    const end_date = (patch.end_date as string) ?? current.end_date
    const is_milestone = "is_milestone" in patch ? (patch.is_milestone as boolean) : current.is_milestone
    patch.duration_days = deriveDurationDays(start_date, end_date, is_milestone)
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
