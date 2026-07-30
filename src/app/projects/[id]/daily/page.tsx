"use client"

import DailyModule from "@/app/dashboard/_modules/DailyModule"
import { useProjectShell } from "../project-chrome"

export default function DailyPage() {
  const { projectId, appProjects, teamMembers, fieldModules } = useProjectShell()
  // ADR-020: fieldModules is null for admin/member/demo (always editable).
  // For field users, daily_reports === true means a can_edit grant; a
  // view-only grant renders the module with every mutation affordance
  // hidden. The DB write gates (0049) are the enforcement; this is UX.
  const canEdit = fieldModules ? fieldModules.daily_reports === true : true
  return <DailyModule globalProjectId={projectId} appProjects={appProjects} teamMembers={teamMembers} canEdit={canEdit} />
}
