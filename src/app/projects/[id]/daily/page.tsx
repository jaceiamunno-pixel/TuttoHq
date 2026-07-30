"use client"

import DailyModule from "@/app/dashboard/_modules/DailyModule"
import { useProjectShell } from "../project-chrome"

export default function DailyPage() {
  const { projectId, appProjects, teamMembers, fieldModules } = useProjectShell()
  // ADR-020: field users with a view-only grant get no mutation affordances.
  // The DB write gates (can_edit) are the enforcement; this is UX.
  const readOnly = fieldModules ? fieldModules.daily_reports !== true : false
  return <DailyModule globalProjectId={projectId} appProjects={appProjects} teamMembers={teamMembers} readOnly={readOnly} />
}
