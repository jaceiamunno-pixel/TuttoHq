"use client"

import ProjectManpower from "./project-manpower"
import { useProjectShell } from "../project-chrome"

// Per-project Manpower tab (Phase 3). The project-scoped crew schedule: this
// project's manpower_assignments, grouped by date, with create/edit/delete. The
// full calendar (and the company-wide "everyone everywhere" view) is Phase 4.
// The same write-layer API (/api/manpower-assignments) backs both — here it's
// read with ?project_id so RLS company-scope + the project filter together pin
// the list to this one project.
export default function ProjectManpowerPage() {
  const { projectId, project } = useProjectShell()
  return <ProjectManpower projectId={projectId} projectName={project.name} />
}
