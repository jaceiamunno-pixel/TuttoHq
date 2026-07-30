import { redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"

// ── ADR-020 field role — shared server-side access helpers ──────────────────
// The DB is the enforcement boundary (0047 project_access + 0049 restrictive
// gates). Everything here is defense-in-depth and UX: server route guards so
// field users get clean redirects instead of RLS-empty screens, and explicit
// checks in front of the SECURITY DEFINER RPCs / service-role paths that RLS
// cannot see through.

import { isFieldModule } from "@/lib/field-access-shared"
import type { FieldModule } from "@/lib/field-access-shared"

export { FIELD_MODULES, FIELD_MODULE_LABELS, isFieldModule, parseGrants } from "@/lib/field-access-shared"
export type { FieldModule, FieldGrant } from "@/lib/field-access-shared"

// Route segment under /projects/[id] → grantable module key.
// null = the module can never be granted to a field user.
export const SLUG_TO_MODULE: Record<string, FieldModule | null> = {
  daily:             "daily_reports",
  drawings:          "drawings",
  schedule:          "schedule",
  rfis:              "rfis",
  submittals:        null,
  "change-orders":   null,
  "purchase-orders": null,
  commitments:       null,
  punch:             null,
  manpower:          null,
  takeoff:           null,
  rfq:               null,
  estimate:          null,
  closeout:          null,
}

// Preference order for the bare /projects/[id] landing redirect.
const FIELD_LANDING_ORDER: { module: FieldModule; slug: string }[] = [
  { module: "daily_reports", slug: "daily" },
  { module: "drawings",      slug: "drawings" },
  { module: "schedule",      slug: "schedule" },
  { module: "rfis",          slug: "rfis" },
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

export async function getMyRole(supabase: AnyClient): Promise<string | null> {
  const { data } = await supabase.rpc("get_my_role")
  return typeof data === "string" ? data : null
}

/** The signed-in field user's grants for one project, as module → can_edit.
 *  Returns null when the caller is not a field user. */
export async function getFieldProjectAccess(
  supabase: AnyClient,
  userId: string,
  projectId: string,
): Promise<Partial<Record<FieldModule, boolean>> | null> {
  const role = await getMyRole(supabase)
  if (role !== "field") return null
  const { data } = await supabase
    .from("project_access")
    .select("module, can_edit")
    .eq("user_id", userId)
    .eq("project_id", projectId)
  const map: Partial<Record<FieldModule, boolean>> = {}
  for (const row of data ?? []) {
    if (isFieldModule(row.module)) map[row.module] = row.can_edit === true
  }
  return map
}

// ── Server-component guards (pages/layouts) ─────────────────────────────────

/** Per-module route guard for /projects/[id]/<slug> layouts. Non-field roles
 *  pass through untouched. A field user hitting an ungranted (or ungrantable)
 *  module is redirected to the project root, which lands on their first
 *  granted module. */
export async function guardProjectModule(projectId: string, slug: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return // outer layout already redirects unauthenticated users
  const access = await getFieldProjectAccess(supabase, user.id, projectId)
  if (access === null) return // admin / member / demo — unchanged behavior
  const moduleKey = SLUG_TO_MODULE[slug] ?? null
  if (!moduleKey || access[moduleKey] === undefined) redirect(`/projects/${projectId}`)
}

/** For the bare /projects/[id] landing: where should this user land? */
export async function resolveProjectLanding(projectId: string): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return `/projects/${projectId}/submittals`
  const access = await getFieldProjectAccess(supabase, user.id, projectId)
  if (access === null) return `/projects/${projectId}/submittals`
  for (const { module, slug } of FIELD_LANDING_ORDER) {
    if (access[module] !== undefined) return `/projects/${projectId}/${slug}`
  }
  // A field user with zero grants can't see the project at all (RLS hides it),
  // so the outer layout notFound()s before this runs. Belt-and-suspenders:
  return "/dashboard"
}

/** Company-level surface guard (/library, /equipment, /manpower,
 *  /directories): field users are redirected to the project list. */
export async function guardCompanySurface(): Promise<void> {
  const supabase = await createClient()
  const role = await getMyRole(supabase)
  if (role === "field") redirect("/dashboard")
}

// ── API-route guards ────────────────────────────────────────────────────────

/** 403 for field callers on surfaces that are locked to them but whose routes
 *  invoke SECURITY DEFINER RPCs or service-role clients (which RLS cannot
 *  gate). Returns a NextResponse to send, or null to proceed. */
export async function forbidFieldRole(supabase: AnyClient): Promise<NextResponse | null> {
  const role = await getMyRole(supabase)
  if (role === "field") {
    return NextResponse.json({ error: "Not available for field accounts" }, { status: 403 })
  }
  return null
}

/** Write-permission check in front of SECURITY DEFINER soft-delete/restore
 *  RPCs on field-grantable modules. Non-field roles always pass. */
export async function fieldCanWriteModule(
  supabase: AnyClient,
  userId: string,
  projectId: string | null,
  module: FieldModule,
): Promise<boolean> {
  const role = await getMyRole(supabase)
  if (role !== "field") return true
  if (!projectId) return false
  const { data } = await supabase
    .from("project_access")
    .select("can_edit")
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("module", module)
    .maybeSingle()
  return data?.can_edit === true
}

/** Guard in front of a SECURITY DEFINER write RPC on a field-grantable
 *  module. Non-field: null (proceed) without ever calling fetchProjectId.
 *  Field: resolves the target's project via the (RLS-gated) fetcher — an
 *  invisible target 404s, a visible one without a can_edit grant 403s. */
export async function forbidFieldWithoutEdit(
  supabase: AnyClient,
  userId: string,
  module: FieldModule,
  fetchProjectId: () => Promise<string | null>,
): Promise<NextResponse | null> {
  const role = await getMyRole(supabase)
  if (role !== "field") return null
  const projectId = await fetchProjectId()
  if (!projectId) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const { data } = await supabase
    .from("project_access")
    .select("can_edit")
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("module", module)
    .maybeSingle()
  if (data?.can_edit !== true) {
    return NextResponse.json({ error: "Edit access required for this module" }, { status: 403 })
  }
  return null
}

/** View-gate for field callers on a known project/module (e.g. the
 *  SECURITY DEFINER recycle-bin listings, which RLS cannot scope). */
export async function forbidFieldWithoutView(
  supabase: AnyClient,
  userId: string,
  projectId: string,
  module: FieldModule,
): Promise<NextResponse | null> {
  const role = await getMyRole(supabase)
  if (role !== "field") return null
  const { data } = await supabase
    .from("project_access")
    .select("id")
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("module", module)
    .maybeSingle()
  if (!data) {
    return NextResponse.json({ error: "Module access required" }, { status: 403 })
  }
  return null
}
