"use client"

import PunchModule from "@/app/dashboard/_modules/PunchModule"
import { useProjectShell } from "../project-chrome"

export default function PunchPage() {
  const { projectId, appProjects } = useProjectShell()
  return <PunchModule globalProjectId={projectId} appProjects={appProjects} />
}
