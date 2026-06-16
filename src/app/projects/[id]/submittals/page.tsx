"use client"

import LibrarySubmittalsModule from "@/app/dashboard/_modules/LibrarySubmittalsModule"
import { useProjectShell } from "../project-chrome"

export default function SubmittalsPage() {
  const { projectId, appProjects, teamMembers, userEmail, submittalsView, setSubmittalsView, navigateModule } = useProjectShell()
  return (
    <LibrarySubmittalsModule
      activeModule="submittals"
      globalProjectId={projectId}
      appProjects={appProjects}
      teamMembers={teamMembers}
      userEmail={userEmail}
      submittalsView={submittalsView}
      setSubmittalsView={setSubmittalsView}
      onNavigate={navigateModule}
    />
  )
}
