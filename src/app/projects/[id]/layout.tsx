import { notFound, redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getFieldProjectAccess } from "@/lib/field-access"
import ProjectChrome from "./project-chrome"

// ── Project-ownership route guard (careful-lane, ADR-006 Phase 2) ───────────
// Runs as a Server Component BEFORE any project chrome or work-module mounts.
//
// The SELECT below is RLS-scoped by the live policy
//   "projects: company select" USING (company_id = get_my_company_id())
// so a project belonging to another company — or a nonexistent id — comes back
// null and we render not-found. The RLS-scoped query IS the ownership check;
// there is no hand-rolled company_id comparison. RLS stays the data-layer
// backstop for every module fetch; this guard just prevents rendering chrome /
// firing module queries for a project the caller may not access.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // Defensive: middleware already redirects unauthenticated users, but never
  // run the guard without a session.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, number, location, gc_name, architect")
    .eq("id", id)
    .maybeSingle()

  if (!project) notFound()

  // ADR-020: field users see only their granted modules. null = not a field
  // user (admin/member/demo — chrome renders unchanged). For field, the
  // project is only visible at all because ≥1 grant exists (RLS visibility
  // gate), so the map is non-empty in practice.
  const fieldModules = await getFieldProjectAccess(supabase, user.id, id)

  return <ProjectChrome project={project} fieldModules={fieldModules}>{children}</ProjectChrome>
}
