"use client"

import DailyModule from "@/app/dashboard/_modules/DailyModule"
import { useProjectShell } from "../project-chrome"

export default function DailyPage() {
  const { projectId, appProjects, teamMembers } = useProjectShell()
  return <DailyModule globalProjectId={projectId} appProjects={appProjects} teamMembers={teamMembers} />
}
