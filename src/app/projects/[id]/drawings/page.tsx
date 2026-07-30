"use client"

import DrawingsModule from "@/app/dashboard/_modules/DrawingsModule"
import { useProjectShell } from "../project-chrome"

export default function DrawingsPage() {
  const { projectId, appProjects, fieldModules } = useProjectShell()
  // ADR-020: field users with a view-only grant get no mutation affordances.
  const readOnly = fieldModules ? fieldModules.drawings !== true : false
  return <DrawingsModule globalProjectId={projectId} appProjects={appProjects} readOnly={readOnly} />
}
