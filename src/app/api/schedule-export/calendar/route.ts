import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, type CalendarChip } from "@/lib/pdf-builder"
import { assembleSchedule, type ScheduleTaskRow, type ScheduleDependencyRow } from "@/lib/schedule/api"

export const maxDuration = 60

// ── Schedule calendar PDF export (ADR-012, calendar follow-up) — READ-ONLY ────
// Re-renders the on-screen month-calendar (schedule-calendar.tsx) server-side as a
// clean handout PDF through the shared pdf-lib engine (PDFBuilder.monthCalendar).
// It WRITES NOTHING — no row insert, no storage upload — it just streams the PDF
// back. The caller sends the CHECKED task ids; the route renders one month page per
// month that holds a selected task.
//
// TENANT SAFETY (the careful seam Claude reviews): the task ids are NEVER trusted.
// We load the project's tasks through the SAME RLS/company-scoped path the GET uses
// (company_id = get_my_company_id() is enforced by RLS; project_id is the extra
// per-project filter, never the security boundary), then render only the requested
// ids that intersect that RLS-visible set. A forged id from another tenant simply
// isn't in the set, so it can't be rendered. Company is resolved from the session by
// RLS — never read from the client.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TASK_COLS = "id, name, start_date, end_date, is_milestone, duration_days"
const DEP_COLS = "id, predecessor_id, successor_id, dep_type, lag_days"

interface ExportTask {
  id: string
  name: string
  start_date: string
  end_date: string
  is_milestone: boolean
  duration_days: number
}

const durationLabel = (t: ExportTask) =>
  t.is_milestone || t.duration_days === 0 ? "milestone" : `${t.duration_days} day${t.duration_days === 1 ? "" : "s"}`

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : ""
  if (!projectId || !UUID_RE.test(projectId)) {
    return NextResponse.json({ error: "project_id (uuid) is required" }, { status: 400 })
  }
  if (!Array.isArray(body.task_ids)) {
    return NextResponse.json({ error: "task_ids must be an array" }, { status: 400 })
  }
  // Keep only well-formed ids; the real authorization is the RLS intersection below.
  const requested = new Set<string>(
    (body.task_ids as unknown[]).filter((v): v is string => typeof v === "string" && UUID_RE.test(v)),
  )
  if (requested.size === 0) {
    return NextResponse.json({ error: "Select at least one task to export" }, { status: 400 })
  }

  // Confirm the project is visible to this caller (RLS scopes projects to the
  // company); a hidden/foreign project_id yields no row → 404, never a leak.
  const { data: project } = await supabase
    .from("projects")
    .select("name, number, gc_name, architect, location")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  // Load the project's tasks + deps through the SAME RLS-scoped path as the GET.
  // This set is the authorization boundary: only ids present here may render.
  const [tasksRes, depsRes] = await Promise.all([
    supabase.from("schedule_tasks").select(TASK_COLS).eq("project_id", projectId).is("deleted_at", null),
    supabase.from("schedule_dependencies").select(DEP_COLS).eq("project_id", projectId),
  ])
  if (tasksRes.error) {
    console.error("schedule-export: failed to load tasks", tasksRes.error)
    return NextResponse.json({ error: "Failed to load schedule" }, { status: 500 })
  }

  const allTasks = (tasksRes.data ?? []) as unknown as ExportTask[]

  // Critical-path overlay, computed exactly like the GET (same seam) so the PDF's
  // red chips agree with the on-screen Gantt/Calendar. Degrades to "none critical"
  // if the schedule can't be computed — never blocks the export.
  const assembled = assembleSchedule(
    allTasks as unknown as ScheduleTaskRow[],
    (depsRes.data ?? []) as unknown as ScheduleDependencyRow[],
  )
  const criticalSet = new Set(assembled.cpm.ok ? assembled.cpm.criticalTaskIds : [])

  // Intersect requested ids with the RLS-visible tasks — the only ids we render.
  const selected = allTasks.filter((t) => requested.has(t.id) && t.start_date)
  if (selected.length === 0) {
    return NextResponse.json({ error: "None of the selected tasks are available to export" }, { status: 400 })
  }

  // Company identity for the header (logo / name) — RLS scopes to the caller's
  // company. select("*") stays resilient if display_name predates a tenant's row.
  const { data: settings } = await supabase.from("company_settings").select("*").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  // Group the selected tasks into month pages (ascending), each a chip in its
  // START-day cell. Stable name order keeps multi-task days tidy.
  const byMonth = new Map<string, ExportTask[]>()
  for (const t of selected) {
    const key = t.start_date.slice(0, 7) // YYYY-MM
    const arr = byMonth.get(key) ?? []
    arr.push(t)
    byMonth.set(key, arr)
  }
  const monthKeys = [...byMonth.keys()].sort()

  const pdf = await PDFBuilder.create({
    documentType: "Schedule Calendar",
    documentNumber: project.name ?? undefined,
    logoBytes,
    brandName: settings?.display_name ?? null,
    logoScalePct: settings?.logo_scale_pct ?? undefined,
    orientation: "landscape",
  })

  monthKeys.forEach((key, i) => {
    if (i > 0) pdf.pageBreak()
    const [y, m] = key.split("-").map(Number)
    const chipsByDay = new Map<number, CalendarChip[]>()
    const list = byMonth.get(key)!.slice().sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name))
    for (const t of list) {
      const day = Number(t.start_date.slice(8, 10))
      const arr = chipsByDay.get(day) ?? []
      arr.push({
        name: t.name,
        durationLabel: durationLabel(t),
        milestone: t.is_milestone,
        critical: criticalSet.has(t.id),
      })
      chipsByDay.set(day, arr)
    }
    pdf.monthCalendar(y, m - 1, chipsByDay)
  })

  const pdfBytes = await pdf.save()
  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="schedule-calendar.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}
