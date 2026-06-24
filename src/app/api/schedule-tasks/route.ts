import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  assembleSchedule,
  deriveDurationDays,
  scheduleTaskCheckMessage,
  type ScheduleTaskRow,
  type ScheduleDependencyRow,
} from "@/lib/schedule/api"

// ── Schedule tasks — list (+ CPM overlay) + create (Phase 3, Slice 2) ────────
// Standard cookie server client; RLS scopes every read/write to the caller's
// company (schedule_tasks.company_id = get_my_company_id()). project_id is a
// REQUIRED additional filter on GET (the schedule is per-project) — never the
// security boundary. company_id + created_by ride their DB defaults and are NEVER
// accepted from the client. Soft-delete/restore go through the RPCs in the [id]
// routes — never a bare deleted_at UPDATE.

const TASK_COLS =
  "id, project_id, name, phase, start_date, end_date, is_milestone, duration_days, " +
  "percent_complete, actual_start_date, actual_end_date, sort_order, wbs_code, status, crew_size, notes, created_at, created_by"

const DEP_COLS =
  "id, project_id, predecessor_id, successor_id, dep_type, lag_days, created_at, created_by"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES = ["not_started", "in_progress", "complete", "backlog"] as const

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// GET /api/schedule-tasks?project_id=<uuid> (REQUIRED)
//   → { tasks: [...rows merged with CPM overlay], dependencies: [...edges], cpm: {...} }
// Both the tasks and the deps are RLS-scoped (company) AND filtered to project_id.
// The bars come straight from the DB; the overlay (early/late/float/critical +
// resolved dates) is computed in-process by the pure CPM engine. A CPM error never
// 500s — assembleSchedule degrades to rows-only with cpm:{ok:false}.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get("project_id")?.trim() || null
  if (!projectId || !UUID_RE.test(projectId)) {
    return NextResponse.json({ error: "project_id (uuid) is required" }, { status: 400 })
  }

  // Active rows only (the SELECT policy already hides deleted_at IS NOT NULL, but
  // the explicit filter keeps the intent obvious and the index in play).
  const tasksQuery = supabase
    .from("schedule_tasks")
    .select(TASK_COLS)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("start_date", { ascending: true })
    .order("created_at", { ascending: true })

  const depsQuery = supabase
    .from("schedule_dependencies")
    .select(DEP_COLS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })

  const [tasksRes, depsRes] = await Promise.all([tasksQuery, depsQuery])

  if (tasksRes.error) {
    console.error("Failed to load schedule tasks:", tasksRes.error)
    return NextResponse.json({ error: "Failed to load schedule tasks" }, { status: 500 })
  }
  if (depsRes.error) {
    console.error("Failed to load schedule dependencies:", depsRes.error)
    return NextResponse.json({ error: "Failed to load schedule dependencies" }, { status: 500 })
  }

  const payload = assembleSchedule(
    (tasksRes.data ?? []) as unknown as ScheduleTaskRow[],
    (depsRes.data ?? []) as unknown as ScheduleDependencyRow[],
  )
  return NextResponse.json(payload)
}

interface CreateInput {
  project_id?: unknown
  name?: unknown
  phase?: unknown
  start_date?: unknown
  end_date?: unknown
  is_milestone?: unknown
  percent_complete?: unknown
  status?: unknown
  crew_size?: unknown
  wbs_code?: unknown
  sort_order?: unknown
  notes?: unknown
  actual_start_date?: unknown
  actual_end_date?: unknown
}

// Validate + build the INSERT row. company_id and created_by are intentionally
// omitted — both ride their DB defaults (get_my_company_id() / auth.uid()) and can
// NEVER be set by the client. duration_days is DERIVED from the dates here (never
// taken from the body) so the cached column can't disagree with the engine — but only
// when both dates are present; a dateless backlog row gets duration_days=null. Dates
// are REQUIRED for a scheduled task and OPTIONAL for a 'backlog' one (migration 0023:
// start/end nullable; a DB CHECK enforces both-present OR status='backlog'). The
// date_order / pct-range / status-enum rules are also DB CHECKs; validating here just
// yields friendlier 400s before the round trip.
function buildInsertRow(input: CreateInput): { row: Record<string, unknown> } | { error: string } {
  const project_id = strOrNull(input.project_id)
  if (!project_id || !UUID_RE.test(project_id)) return { error: "project_id (uuid) is required" }

  const name = strOrNull(input.name)
  if (!name) return { error: "name is required" }

  // status drives whether dates are required, so validate it first.
  let status: string = "not_started"
  if (input.status !== undefined && input.status !== null && input.status !== "") {
    if (!STATUSES.includes(input.status as (typeof STATUSES)[number])) {
      return { error: "status must be not_started, in_progress, complete, or backlog" }
    }
    status = input.status as string
  }

  // Dates: REQUIRED for a scheduled task; OPTIONAL for a backlog row. A backlog row may
  // carry no dates (both null), but a PRESENT date must still be a valid YYYY-MM-DD — a
  // malformed date is a 400, never a silent null. Non-backlog keeps the strict contract.
  const start_date = strOrNull(input.start_date)
  const end_date = strOrNull(input.end_date)
  if (status === "backlog") {
    if (start_date && !DATE_RE.test(start_date)) return { error: "start_date must be YYYY-MM-DD" }
    if (end_date && !DATE_RE.test(end_date)) return { error: "end_date must be YYYY-MM-DD" }
  } else {
    if (!start_date || !DATE_RE.test(start_date)) return { error: "start_date (YYYY-MM-DD) is required" }
    if (!end_date || !DATE_RE.test(end_date)) return { error: "end_date (YYYY-MM-DD) is required" }
  }

  let is_milestone = false
  if (input.is_milestone !== undefined && input.is_milestone !== null) {
    if (typeof input.is_milestone !== "boolean") return { error: "is_milestone must be a boolean" }
    is_milestone = input.is_milestone
  }

  let percent_complete = 0
  if (input.percent_complete !== undefined && input.percent_complete !== null && input.percent_complete !== "") {
    const n = Number(input.percent_complete)
    if (!Number.isInteger(n) || n < 0 || n > 100) return { error: "percent_complete must be a whole number 0–100" }
    percent_complete = n
  }

  let sort_order = 0
  if (input.sort_order !== undefined && input.sort_order !== null && input.sort_order !== "") {
    const n = Number(input.sort_order)
    if (!Number.isInteger(n)) return { error: "sort_order must be a whole number" }
    sort_order = n
  }

  for (const k of ["actual_start_date", "actual_end_date"] as const) {
    const v = strOrNull(input[k])
    if (v && !DATE_RE.test(v)) return { error: `${k} must be YYYY-MM-DD` }
  }

  // crew_size: optional non-negative whole number; null when absent.
  let crew_size: number | null = null
  if (input.crew_size !== undefined && input.crew_size !== null && input.crew_size !== "") {
    const n = Number(input.crew_size)
    if (!Number.isInteger(n) || n < 0) return { error: "crew_size must be a whole number ≥ 0" }
    crew_size = n
  }

  const row: Record<string, unknown> = {
    project_id,
    name,
    phase: strOrNull(input.phase),
    start_date,
    end_date,
    is_milestone,
    // duration only when both dates are present; a dateless backlog row has no span.
    duration_days: start_date && end_date ? deriveDurationDays(start_date, end_date, is_milestone) : null,
    percent_complete,
    status,
    crew_size,
    wbs_code: strOrNull(input.wbs_code),
    sort_order,
    notes: strOrNull(input.notes),
    actual_start_date: strOrNull(input.actual_start_date),
    actual_end_date: strOrNull(input.actual_end_date),
  }
  return { row }
}

// POST /api/schedule-tasks — create one task. Required: project_id, name; plus
// start_date + end_date UNLESS status='backlog' (a backlog row may be dateless).
// The project_id must reference an RLS-visible project, so a task can't be attached to
// another tenant's project even though the INSERT policy only checks company_id. DB
// CHECKs (date order / dates-present-or-backlog / pct / status) map to clean 400s.
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

  // Tenant isolation: confirm the target project is visible to this caller (RLS on
  // projects scopes to the company). Without this, the schedule_tasks INSERT policy
  // (company_id-only) would let a task ride a foreign project_id.
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", built.row.project_id as string)
    .maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  const { data, error } = await supabase
    .from("schedule_tasks")
    .insert(built.row)
    .select(TASK_COLS)
    .single()

  if (error) {
    const friendly = scheduleTaskCheckMessage(error)
    if (friendly) return NextResponse.json({ error: friendly }, { status: 400 })
    console.error("Failed to create schedule task:", error)
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 })
  }
  return NextResponse.json({ task: data }, { status: 201 })
}
