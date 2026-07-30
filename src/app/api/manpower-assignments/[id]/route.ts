import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { workerHasConflict, checkViolationMessage, type AssignmentStatus } from "@/lib/manpower"

// ── Manpower assignments — edit + soft-delete (Phase 3 write-layer) ──────────
// Standard cookie server client; RLS scopes every read/write to the caller's
// company. PATCH is a plain UPDATE over an explicit allow-list (it never touches
// deleted_at, so the post-update row still satisfies the deleted_at-IS-NULL
// SELECT policy). DELETE soft-deletes via the SECURITY DEFINER RPC — never a bare
// deleted_at UPDATE. company_id/created_by are never re-resolved from the client.

const SELECT_COLS = `
  id, project_id, assignee_type, worker_id, vendor_id,
  work_date, start_time, end_time, status, crew_size, description, notes, created_at,
  worker:workers ( id, full_name, trade ),
  vendor:vendors ( id, company_name )
`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// PATCH /api/manpower-assignments/[id] — edit from an explicit allow-list:
// work_date, start_time, end_time, status, crew_size, description, notes, and a
// reassignment of the assignee (worker_id|vendor_id together with assignee_type).
// Reassignment requires assignee_type so the off-side id is always nulled in the
// same write — that keeps the manpower_assignee_exclusive CHECK satisfied. Like
// create, a double-booked worker is flagged (conflict: true), never blocked.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if ("work_date" in body) {
    const v = strOrNull(body.work_date)
    if (!v || !DATE_RE.test(v)) return NextResponse.json({ error: "work_date must be YYYY-MM-DD" }, { status: 400 })
    patch.work_date = v
  }
  // start/end may be cleared by sending null or "" → strOrNull collapses to null.
  // The DB CHECK manpower_time_order validates the final row when only one bound
  // changes; we surface that as a clean 400 below.
  for (const k of ["start_time", "end_time"] as const) {
    if (k in body) {
      const v = strOrNull(body[k])
      if (v && !TIME_RE.test(v)) return NextResponse.json({ error: `${k} must be HH:MM` }, { status: 400 })
      patch[k] = v
    }
  }
  if ("status" in body) {
    const s = body.status
    if (s !== "planned" && s !== "actual") return NextResponse.json({ error: "status must be 'planned' or 'actual'" }, { status: 400 })
    patch.status = s as AssignmentStatus
  }
  if ("crew_size" in body) {
    const raw = body.crew_size
    if (raw === null || raw === "") {
      patch.crew_size = null
    } else {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: "crew_size must be a positive whole number" }, { status: 400 })
      patch.crew_size = n
    }
  }
  if ("description" in body) patch.description = strOrNull(body.description)
  if ("notes" in body) patch.notes = strOrNull(body.notes)

  // Reassignment: assignee_type must accompany the new id so we can null the
  // off-side column atomically and stay inside the exclusive CHECK.
  if ("assignee_type" in body || "worker_id" in body || "vendor_id" in body) {
    const at = body.assignee_type
    if (at !== "worker" && at !== "vendor") {
      return NextResponse.json({ error: "Reassigning requires assignee_type 'worker' or 'vendor'" }, { status: 400 })
    }
    if (at === "worker") {
      const wid = strOrNull(body.worker_id)
      if (!wid || !UUID_RE.test(wid)) return NextResponse.json({ error: "worker_id is required when assignee_type is 'worker'" }, { status: 400 })
      patch.assignee_type = "worker"
      patch.worker_id = wid
      patch.vendor_id = null
    } else {
      const vid = strOrNull(body.vendor_id)
      if (!vid || !UUID_RE.test(vid)) return NextResponse.json({ error: "vendor_id is required when assignee_type is 'vendor'" }, { status: 400 })
      patch.assignee_type = "vendor"
      patch.vendor_id = vid
      patch.worker_id = null
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }

  // .maybeSingle() doubles as the tenant/existence check: RLS limits the UPDATE to
  // this company's live rows, so a cross-company or soft-deleted id updates 0 rows
  // → null → 404.
  const { data, error } = await supabase
    .from("manpower_assignments")
    .update(patch)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle()

  if (error) {
    const friendly = checkViolationMessage(error)
    if (friendly) return NextResponse.json({ error: friendly }, { status: 400 })
    console.error("Failed to update manpower assignment:", error)
    return NextResponse.json({ error: "Failed to update assignment" }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: "Assignment not found" }, { status: 404 })

  // Re-probe the double-book using the row's resulting values (any of which the
  // edit may have changed), excluding the row itself. Worker assignments only.
  const row = data as { id: string; assignee_type: string; worker_id: string | null; work_date: string; start_time: string | null; end_time: string | null }
  let conflict = false
  if (row.assignee_type === "worker" && row.worker_id) {
    conflict = await workerHasConflict(supabase, {
      worker_id: row.worker_id,
      work_date: row.work_date,
      start_time: row.start_time,
      end_time: row.end_time,
      excludeId: row.id,
    })
  }

  return NextResponse.json({ assignment: data, conflict })
}

// DELETE /api/manpower-assignments/[id] — SOFT delete via the
// soft_delete_manpower_assignment SECURITY DEFINER RPC (migration 0021),
// company-scoped internally via get_my_company_id(). NOT a bare UPDATE deleted_at
// (that would fall outside the deleted_at-IS-NULL policy and be rejected 42501).
// The RPC returns the id on success, or no row if not found / cross-company /
// already deleted → 404.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data: deletedId, error } = await supabase.rpc("soft_delete_manpower_assignment", { p_id: id })
  if (error) {
    console.error("Failed to soft-delete manpower assignment:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!deletedId) return NextResponse.json({ error: "Assignment not found or already deleted" }, { status: 404 })
  return NextResponse.json({ ok: true, id })
}
