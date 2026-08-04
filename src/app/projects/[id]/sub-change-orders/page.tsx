"use client"

import SubChangeOrdersModule from "@/app/dashboard/_modules/SubChangeOrdersModule"
import { useProjectShell } from "../project-chrome"

export default function SubChangeOrdersPage() {
  const { projectId, appProjects } = useProjectShell()
  return <SubChangeOrdersModule globalProjectId={projectId} appProjects={appProjects} />
}
