"use client"

import { notFound } from "next/navigation"
import PunchModule from "@/app/dashboard/_modules/PunchModule"
import { useProjectShell } from "../project-chrome"
import { isFeatureEnabled } from "@/lib/features"

export default function PunchPage() {
  const { projectId, appProjects } = useProjectShell()
  // Punch List is feature-hidden: the route stays in the tree but is not live
  // (so a bookmarked/typed URL 404s rather than being orphaned-but-reachable).
  // Re-enable by flipping `punchList` in @/lib/features.
  if (!isFeatureEnabled("punchList")) notFound()
  return <PunchModule globalProjectId={projectId} appProjects={appProjects} />
}
