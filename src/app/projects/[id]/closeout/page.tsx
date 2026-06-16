"use client"

import CloseoutModule from "@/app/dashboard/_modules/CloseoutModule"
import { useProjectShell } from "../project-chrome"

export default function CloseoutPage() {
  const { projectId, appProjects, teamMembers, setCloseoutPct, navigateModule } = useProjectShell()
  return (
    <CloseoutModule
      globalProjectId={projectId}
      appProjects={appProjects}
      teamMembers={teamMembers}
      onProgress={setCloseoutPct}
      onNavigate={navigateModule}
    />
  )
}
