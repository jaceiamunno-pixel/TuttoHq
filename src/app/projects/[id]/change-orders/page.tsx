"use client"

import ChangeOrdersModule from "@/app/dashboard/_modules/ChangeOrdersModule"
import { useProjectShell } from "../project-chrome"

export default function ChangeOrdersPage() {
  const { projectId, appProjects } = useProjectShell()
  return <ChangeOrdersModule globalProjectId={projectId} appProjects={appProjects} />
}
