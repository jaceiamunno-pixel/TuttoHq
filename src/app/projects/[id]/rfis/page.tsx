"use client"

import RfisModule from "@/app/dashboard/_modules/RfisModule"
import { useProjectShell } from "../project-chrome"

export default function RfisPage() {
  const { projectId, appProjects, teamMembers, fieldModules } = useProjectShell()
  // ADR-020: field users with a view-only grant get no mutation affordances.
  const readOnly = fieldModules ? fieldModules.rfis !== true : false
  return <RfisModule globalProjectId={projectId} appProjects={appProjects} teamMembers={teamMembers} readOnly={readOnly} />
}
