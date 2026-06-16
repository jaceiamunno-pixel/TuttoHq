"use client"

import PurchaseOrdersModule from "@/app/dashboard/_modules/PurchaseOrdersModule"
import { useProjectShell } from "../project-chrome"

// Purchase Orders reads commitments WHERE type='purchase_order' (no
// purchase_orders table). Mounting only — module + its PATCH route unchanged.
export default function PurchaseOrdersPage() {
  const { projectId, appProjects } = useProjectShell()
  return <PurchaseOrdersModule appProjects={appProjects} globalProjectId={projectId} />
}
