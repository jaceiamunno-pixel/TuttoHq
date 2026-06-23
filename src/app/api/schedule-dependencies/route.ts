import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  wouldCreateCycle,
  scheduleDepCheckMessage,
  type ScheduleTaskRow,
  type ScheduleDependencyRow,
  type ProposedEdge,
} from "@/lib/schedule/api"

// ── Schedule dependencies — create an edge with the CYCLE GATE (Phase 3, Slice 2)
// Standard cookie server client; RLS scopes every read/write to the caller's
// company. company_id + created_by ride their DB defaults — NEVER from the client.
// The correctness-critical part is the cycle gate: BEFORE inserting we run the pure
// CPM engine over the would-be graph and reject 409 if the new edge closes a cycle,
// so the DB never holds a cyclic dependency graph.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEP_TYPES = ["FS", "SS", "FF", "SF"] as const
const DEP_COLS =
  "id, project_id, predecessor_id, successor_id, dep_type, lag_days, created_at, created_by"

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null

// POST /api/schedule-dependencies — create one edge.
// Required: project_id, predecessor_id, successor_id. Optional: dep_type ('FS'),
// lag_days (0). Gate order:
//   1. shape/validation (uuids, dep_type enum, integer lag) → 400
//   2. self-edge (pred == succ) → 400 (also a DB CHECK; we reject before the gate)
//   3. project visible to caller → 404 (tenant isolation; INSERT policy is
//      company_id-only so a foreign project_id would otherwise slip through)
//   4. both endpoints are tasks IN THIS PROJECT (RLS-scoped fetch) → 400 if not;
//      this also blocks cross-project / soft-deleted / cross-tenant endpoints,
//      keeping a foreign task out of the graph the gate evaluates
//   5. CYCLE GATE: run the engine over existing edges + the proposed one → 409 if cyclic
//   6. insert; map UNIQUE (23505) → 409 and any CHECK (23514) → 400
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  // 1. Shape/validation.
  const project_id = strOrNull(body.project_id)
  if (!project_id || !UUID_RE.test(project_id)) {
    return NextResponse.json({ error: "project_id (uuid) is required" }, { status: 400 })
  }
  const predecessor_id = strOrNull(body.predecessor_id)
  if (!predecessor_id || !UUID_RE.test(predecessor_id)) {
    return NextResponse.json({ error: "predecessor_id (uuid) is required" }, { status: 400 })
  }
  const successor_id = strOrNull(body.successor_id)
  if (!successor_id || !UUID_RE.test(successor_id)) {
    return NextResponse.json({ error: "successor_id (uuid) is required" }, { status: 400 })
  }

  let dep_type = "FS"
  if (body.dep_type !== undefined && body.dep_type !== null && body.dep_type !== "") {
    if (!DEP_TYPES.includes(body.dep_type as (typeof DEP_TYPES)[number])) {
      return NextResponse.json({ error: "dep_type must be FS, SS, FF, or SF" }, { status: 400 })
    }
    dep_type = body.dep_type as string
  }

  let lag_days = 0
  if (body.lag_days !== undefined && body.lag_days !== null && body.lag_days !== "") {
    const n = Number(body.lag_days)
    if (!Number.isInteger(n)) return NextResponse.json({ error: "lag_days must be a whole number (negative = lead)" }, { status: 400 })
    lag_days = n
  }

  // 2. Self-edge (also enforced by the no_self_dependency CHECK).
  if (predecessor_id === successor_id) {
    return NextResponse.json({ error: "A task cannot depend on itself." }, { status: 400 })
  }

  // 3. Tenant isolation — the target project must be visible to the caller.
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", project_id)
    .maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  // Fetch this project's live tasks + existing edges. BOTH reads are RLS-scoped
  // (company) AND filtered to project_id, so the graph the gate evaluates can never
  // be poisoned by another tenant's or another project's rows.
  const [tasksRes, depsRes] = await Promise.all([
    supabase
      .from("schedule_tasks")
      .select("id, start_date, end_date, is_milestone")
      .eq("project_id", project_id)
      .is("deleted_at", null),
    supabase
      .from("schedule_dependencies")
      .select("id, predecessor_id, successor_id, dep_type, lag_days")
      .eq("project_id", project_id),
  ])
  if (tasksRes.error || depsRes.error) {
    console.error("Failed to load schedule graph for cycle gate:", tasksRes.error ?? depsRes.error)
    return NextResponse.json({ error: "Failed to validate dependency" }, { status: 500 })
  }

  const taskRows = (tasksRes.data ?? []) as unknown as ScheduleTaskRow[]
  const depRows = (depsRes.data ?? []) as unknown as ScheduleDependencyRow[]

  // 4. Both endpoints must be tasks in this project (RLS-visible & non-deleted).
  const taskIds = new Set(taskRows.map((t) => t.id))
  if (!taskIds.has(predecessor_id) || !taskIds.has(successor_id)) {
    return NextResponse.json(
      { error: "predecessor and successor must both be tasks in this project" },
      { status: 400 },
    )
  }

  // 5. CYCLE GATE — run the engine over the would-be graph BEFORE inserting.
  const proposed: ProposedEdge = { predecessor_id, successor_id, dep_type, lag_days }
  const gate = wouldCreateCycle(taskRows, depRows, proposed)
  if (gate.cycle) {
    return NextResponse.json(
      { error: "This dependency would create a cycle.", cycleNodeIds: gate.cycleNodeIds },
      { status: 409 },
    )
  }

  // 6. Insert. company_id + created_by ride their DB defaults.
  const { data, error } = await supabase
    .from("schedule_dependencies")
    .insert({ project_id, predecessor_id, successor_id, dep_type, lag_days })
    .select(DEP_COLS)
    .single()

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "An edge between these tasks already exists." }, { status: 409 })
    }
    const friendly = scheduleDepCheckMessage(error)
    if (friendly) return NextResponse.json({ error: friendly }, { status: 400 })
    if (error.code === "23503") {
      return NextResponse.json({ error: "predecessor, successor, or project not found" }, { status: 400 })
    }
    console.error("Failed to create schedule dependency:", error)
    return NextResponse.json({ error: "Failed to create dependency" }, { status: 500 })
  }
  return NextResponse.json({ dependency: data }, { status: 201 })
}
