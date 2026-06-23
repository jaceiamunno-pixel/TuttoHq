import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { workerHasConflict, checkViolationMessage, type AssigneeType, type AssignmentStatus } from "@/lib/manpower"

// ── Manpower assignments — list + create (Phase 3 write-layer) ───────────────
// Standard cookie server client; RLS scopes every read/write to the caller's
// company (manpower_assignments.company_id = get_my_company_id()). project_id is
// an ADDITIONAL filter, never the security boundary — the same rows back both a
// per-project view (?project_id=…) and the company-wide "everyone everywhere"
// view (no project_id). company_id + created_by ride their DB defaults and are
// NEVER accepted from the client. Soft-delete/restore go through the RPCs in the
// [id] routes — never a bare deleted_at UPDATE.

// Embed the worker (full_name + trade) or vendor (company_name) via the FK so the
// calendar can label every row without an N+1. A soft-deleted worker/vendor is
// hidden by its own SELECT policy and embeds as null — the client falls back to
// its already-loaded roster for the label.
const SELECT_COLS = `
  id, project_id, assignee_type, worker_id, vendor_id,
  work_date, start_time, end_time, status, crew_size, description, notes, created_at,
  worker:workers ( id, full_name, trade ),
  vendor:vendors ( id, company_name )
`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// First/last calendar day of the month containing `d`, as YYYY-MM-DD. Used as the
// default read window when the client sends neither ?from nor ?to.
function monthBounds(d: Date): { from: string; to: string } {
  const y = d.getUTCFullYear(), m = d.getUTCMonth()
  const iso = (dt: Date) => dt.toISOString().slice(0, 10)
  return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) }
}

// GET /api/manpower-assignments
//   ?project_id=<uuid>   → that project's assignments (per-project tab). Omit for
//                          the company-wide view (RLS company scope only).
//   ?from=&to=<date>     → inclusive work_date window. Defaults to the current
//                          month when both are absent (the calendar's primary read).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const projectId = sp.get("project_id")?.trim() || null
  const fromRaw = sp.get("from")?.trim() || null
  const toRaw = sp.get("to")?.trim() || null

  if (projectId && !UUID_RE.test(projectId)) {
    return NextResponse.json({ error: "Invalid project_id" }, { status: 400 })
  }
  if (fromRaw && !DATE_RE.test(fromRaw)) return NextResponse.json({ error: "Invalid from date" }, { status: 400 })
  if (toRaw && !DATE_RE.test(toRaw)) return NextResponse.json({ error: "Invalid to date" }, { status: 400 })

  // Default to the current month only when NEITHER bound is given; a single bound
  // is honored as an open-ended range so callers can ask for "everything since X".
  const def = monthBounds(new Date())
  const from = fromRaw ?? (toRaw ? null : def.from)
  const to = toRaw ?? (fromRaw ? null : def.to)

  let query = supabase
    .from("manpower_assignments")
    .select(SELECT_COLS)
    .order("work_date", { ascending: true })
    .order("start_time", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })

  if (projectId) query = query.eq("project_id", projectId)
  if (from) query = query.gte("work_date", from)
  if (to) query = query.lte("work_date", to)

  const { data, error } = await query
  if (error) {
    console.error("Failed to load manpower assignments:", error)
    return NextResponse.json({ error: "Failed to load assignments" }, { status: 500 })
  }
  return NextResponse.json({ assignments: data ?? [] })
}

interface CreateInput {
  project_id?: unknown
  assignee_type?: unknown
  worker_id?: unknown
  vendor_id?: unknown
  work_date?: unknown
  start_time?: unknown
  end_time?: unknown
  status?: unknown
  crew_size?: unknown
  description?: unknown
  notes?: unknown
}

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// Validate + build the INSERT row from raw client input. company_id and created_by
// are intentionally omitted — both ride their DB defaults (get_my_company_id() /
// auth.uid()) and can NEVER be set by the client. Returns an error string on the
// first problem. The assignee-exclusive + time-order rules are also enforced by
// DB CHECKs; validating here just yields friendlier 400s before the round trip.
function buildInsertRow(input: CreateInput): { row: Record<string, unknown>; worker_id: string | null } | { error: string } {
  const project_id = strOrNull(input.project_id)
  if (!project_id || !UUID_RE.test(project_id)) return { error: "project_id is required" }

  const work_date = strOrNull(input.work_date)
  if (!work_date || !DATE_RE.test(work_date)) return { error: "work_date (YYYY-MM-DD) is required" }

  const assignee_type = input.assignee_type
  if (assignee_type !== "worker" && assignee_type !== "vendor") {
    return { error: "assignee_type must be 'worker' or 'vendor'" }
  }
  const worker_id = strOrNull(input.worker_id)
  const vendor_id = strOrNull(input.vendor_id)
  if (assignee_type === "worker") {
    if (!worker_id || !UUID_RE.test(worker_id)) return { error: "worker_id is required for a worker assignment" }
    if (vendor_id) return { error: "A worker assignment cannot also set vendor_id" }
  } else {
    if (!vendor_id || !UUID_RE.test(vendor_id)) return { error: "vendor_id is required for a vendor assignment" }
    if (worker_id) return { error: "A vendor assignment cannot also set worker_id" }
  }

  const start_time = strOrNull(input.start_time)
  const end_time = strOrNull(input.end_time)
  if (start_time && !TIME_RE.test(start_time)) return { error: "start_time must be HH:MM" }
  if (end_time && !TIME_RE.test(end_time)) return { error: "end_time must be HH:MM" }

  let status: AssignmentStatus = "planned"
  if (input.status !== undefined && input.status !== null) {
    if (input.status !== "planned" && input.status !== "actual") {
      return { error: "status must be 'planned' or 'actual'" }
    }
    status = input.status
  }

  let crew_size: number | null = null
  if (input.crew_size !== undefined && input.crew_size !== null && input.crew_size !== "") {
    const n = Number(input.crew_size)
    if (!Number.isInteger(n) || n < 1) return { error: "crew_size must be a positive whole number" }
    crew_size = n
  }

  const row: Record<string, unknown> = {
    project_id,
    assignee_type: assignee_type as AssigneeType,
    worker_id: assignee_type === "worker" ? worker_id : null,
    vendor_id: assignee_type === "vendor" ? vendor_id : null,
    work_date,
    start_time,
    end_time,
    status,
    crew_size,
    description: strOrNull(input.description),
    notes: strOrNull(input.notes),
  }
  return { row, worker_id: assignee_type === "worker" ? worker_id : null }
}

// POST /api/manpower-assignments — create one assignment. Double-booking a worker
// is ALLOWED, never blocked (Jace's call): the row is created normally and the
// response carries { conflict: true } when that worker already has an overlapping
// block that day, so the UI can badge it.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const built = buildInsertRow(body as CreateInput)
  if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 })

  const { data, error } = await supabase
    .from("manpower_assignments")
    .insert(built.row)
    .select(SELECT_COLS)
    .single()

  if (error) {
    const friendly = checkViolationMessage(error)
    if (friendly) return NextResponse.json({ error: friendly }, { status: 400 })
    console.error("Failed to create manpower assignment:", error)
    return NextResponse.json({ error: "Failed to create assignment" }, { status: 500 })
  }

  // Soft double-book probe (worker assignments only). Excludes the row just
  // created so it never conflicts with itself. A probe failure never blocks.
  let conflict = false
  if (built.worker_id) {
    conflict = await workerHasConflict(supabase, {
      worker_id: built.worker_id,
      work_date: built.row.work_date as string,
      start_time: built.row.start_time as string | null,
      end_time: built.row.end_time as string | null,
      excludeId: (data as { id: string }).id,
    })
  }

  return NextResponse.json({ assignment: data, conflict }, { status: 201 })
}
