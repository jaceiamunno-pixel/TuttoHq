"use client"

import TakeoffModule from "./_components/TakeoffModule"
import { useProjectShell } from "../project-chrome"

export default function TakeoffPage() {
  const { projectId, project } = useProjectShell()
  return <TakeoffModule projectId={projectId} projectName={project.name} />
}
