import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseGrants } from "@/lib/field-access-shared"

// ADR-020 — per-member project_access management (Settings → Team → Manage
// access, field members only). Admin-gated at the route AND at the DB: every
// project_access write below runs on the SESSION client, so the 0047
// admin-only RLS policies are the real boundary — this route can't do
// anything a non-admin session couldn't.
//
// The one admin-client use is READ-ONLY: the target user's profile lives in
// user_profiles, whose RLS doesn't let one user read another's row (the
// existing /api/team/members GET has the same shape). Company scoping is
// enforced by comparing against the CALLER's company id.

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { fail: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return { fail: NextResponse.json({ error: "Admin role required" }, { status: 403 }) }
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return { fail: NextResponse.json({ error: "No company association" }, { status: 500 }) }
  return { user, companyId: companyId as string }
}

async function requireFieldTarget(companyId: string, userId: string) {
  const admin = createAdminClient()
  const { data: target } = await admin
    .from("user_profiles")
    .select("company_id, role")
    .eq("user_id", userId)
    .maybeSingle()
  if (!target || target.company_id !== companyId) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 })
  }
  if (target.role !== "field") {
    return NextResponse.json({ error: "Access grants only apply to field members" }, { status: 400 })
  }
  return null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params
  const supabase = await createClient()
  const gate = await requireAdmin(supabase)
  if ("fail" in gate) return gate.fail

  const targetFail = await requireFieldTarget(gate.companyId, userId)
  if (targetFail) return targetFail

  // Session client — company-scoped SELECT policy applies.
  const { data, error } = await supabase
    .from("project_access")
    .select("project_id, module, can_edit")
    .eq("user_id", userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ grants: data ?? [] })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params
  const supabase = await createClient()
  const gate = await requireAdmin(supabase)
  if ("fail" in gate) return gate.fail

  const targetFail = await requireFieldTarget(gate.companyId, userId)
  if (targetFail) return targetFail

  const body = await req.json().catch(() => ({}))
  const { grants, invalid } = parseGrants(body.grants)
  if (invalid > 0) {
    return NextResponse.json({ error: "grants contains malformed entries" }, { status: 400 })
  }

  // Every referenced project must belong to the caller's company. The
  // RLS-scoped SELECT is the ownership check.
  const projectIds = [...new Set(grants.map(g => g.project_id))]
  if (projectIds.length > 0) {
    const { data: owned } = await supabase.from("projects").select("id").in("id", projectIds)
    const ownedIds = new Set((owned ?? []).map(p => p.id))
    if (projectIds.some(id => !ownedIds.has(id))) {
      return NextResponse.json({ error: "grants reference unknown projects" }, { status: 400 })
    }
  }

  // Replace-all semantics: the grid is the source of truth. Upsert the kept
  // grants first, then delete anything not in the new set — two statements,
  // not atomic, but ordered so a failure between them can only leave EXTRA
  // access briefly listed, never wipe a member's access unexpectedly.
  if (grants.length > 0) {
    const rows = grants.map(g => ({
      // company_id defaults via get_my_company_id() on the session insert.
      user_id:    userId,
      project_id: g.project_id,
      module:     g.module,
      can_edit:   g.can_edit,
      granted_by: gate.user.id,
    }))
    const { error: upErr } = await supabase
      .from("project_access")
      .upsert(rows, { onConflict: "user_id,project_id,module" })
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  const keepKeys = grants.map(g => `${g.project_id}:${g.module}`)
  const { data: existing, error: exErr } = await supabase
    .from("project_access")
    .select("id, project_id, module")
    .eq("user_id", userId)
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 })
  const toDelete = (existing ?? [])
    .filter(r => !keepKeys.includes(`${r.project_id}:${r.module}`))
    .map(r => r.id)
  if (toDelete.length > 0) {
    const { error: delErr } = await supabase
      .from("project_access")
      .delete()
      .in("id", toDelete)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, granted: grants.length, removed: toDelete.length })
}
