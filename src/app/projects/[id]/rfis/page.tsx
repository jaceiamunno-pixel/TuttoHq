"use client"

import RfisModule from "@/app/dashboard/_modules/RfisModule"
import { useProjectShell } from "../project-chrome"

export default function RfisPage() {
  const { projectId, appProjects, teamMembers } = useProjectShell()
  return <RfisModule globalProjectId={projectId} appProjects={appProjects} teamMembers={teamMembers} />
}
