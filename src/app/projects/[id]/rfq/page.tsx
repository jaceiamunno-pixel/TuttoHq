"use client"

import RfqModule from "@/app/dashboard/_modules/RfqModule"
import { useProjectShell } from "../project-chrome"

export default function RfqPage() {
  const { projectId, appProjects } = useProjectShell()
  return <RfqModule globalProjectId={projectId} appProjects={appProjects} />
}
