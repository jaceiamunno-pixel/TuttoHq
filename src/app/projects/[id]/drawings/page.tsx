"use client"

import DrawingsModule from "@/app/dashboard/_modules/DrawingsModule"
import { useProjectShell } from "../project-chrome"

export default function DrawingsPage() {
  const { projectId, appProjects } = useProjectShell()
  return <DrawingsModule globalProjectId={projectId} appProjects={appProjects} />
}
