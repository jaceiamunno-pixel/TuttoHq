"use client"

import ProjectManpower from "./project-manpower"
import { useProjectShell } from "../project-chrome"

// Per-project Manpower tab (Phase 4). The project-scoped crew schedule on a
// literal month grid: this project's manpower_assignments for the visible month,
// with create/edit/delete via day detail. The same shared <ManpowerCalendar />
// backs the company-wide "everyone everywhere" Schedule tab — here it's read with
// ?project_id so RLS company-scope + the project filter together pin it to this
// one project.
export default function ProjectManpowerPage() {
  const { projectId, project } = useProjectShell()
  return <ProjectManpower projectId={projectId} projectName={project.name} />
}
