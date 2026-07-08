"use client"

import EstimateModule from "@/app/dashboard/_modules/EstimateModule"
import { useProjectShell } from "../project-chrome"

export default function EstimatePage() {
  const { projectId, appProjects } = useProjectShell()
  return <EstimateModule globalProjectId={projectId} appProjects={appProjects} />
}
