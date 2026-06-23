"use client"

import ProjectSchedule from "./project-schedule"
import { useProjectShell } from "../project-chrome"

// Per-project Schedule tab (ADR-011 Phase 3, Slice 3 — the Gantt UI). A classic
// two-panel Gantt: a phase-grouped task table on the left, time-scaled bars on the
// right. It consumes the Slice-2 routes verbatim — GET /api/schedule-tasks returns
// the bars already merged with the CPM overlay (early/late/float/critical + resolved
// dates), so the engine's schedule is rendered as-is; nothing is recomputed in the
// browser. RLS company-scope + the project_id filter pin every read/write to this
// one project.
export default function ProjectSchedulePage() {
  const { projectId, project } = useProjectShell()
  return <ProjectSchedule projectId={projectId} projectName={project.name} />
}
