"use client"

import CommitmentsView from "@/app/dashboard/_modules/CommitmentsView"
import { useProjectShell } from "../project-chrome"

// Commitments = supplier contracts (commitments WHERE type='supplier_contract')
// and the POs released against them. Mounting only — the module owns the data.
export default function CommitmentsPage() {
  const { projectId, appProjects } = useProjectShell()
  return <CommitmentsView appProjects={appProjects} globalProjectId={projectId} />
}
