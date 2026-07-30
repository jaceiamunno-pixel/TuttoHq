import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Phase 5 — role management + remove user. Admin-only.
//
// Both handlers use the COOKIE client to call the SECURITY DEFINER functions
// (set_user_role / remove_user_from_company) so that auth.uid() inside the
// function correctly identifies the caller. The functions are GRANTed to
// `authenticated` and do their own role + cross-company + last-admin guard
// checks. The route's pre-check below is the defense-in-depth layer that
// returns a clean 403 instead of relying on the function's reject path.
//
// INVARIANT: user_profiles writes go via SECURITY DEFINER. These two
// functions (set_user_role, remove_user_from_company) are the sanctioned
// mutation path for member roles and removals — see the "user_profiles:
// select own" policy block in migrations.sql.

const ROLE_VALUES = ["admin", "member"] as const
type Role = (typeof ROLE_VALUES)[number]

const ERROR_MAP: Record<string, { msg: string; status: number }> = {
  unauthenticated:   { msg: "Unauthorized",                                                                  status: 401 },
  caller_no_company: { msg: "Server error",                                                                  status: 500 },
  not_admin:         { msg: "Admin role required",                                                           status: 403 },
  invalid_role:      { msg: "Role must be 'admin' or 'member'",                                              status: 400 },
  target_not_found:  { msg: "Member not found",                                                              status: 404 },
  cross_company:     { msg: "Member not found",                                                              status: 404 },
  last_admin:        { msg: "A company must have at least one admin. Promote another member first.",        status: 409 },
}

function mapError(code: string | null | undefined) {
  const hit = code ? ERROR_MAP[code] : undefined
  return hit ?? { msg: "Server error", status: 500 }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const { userId } = await params
  const body = await req.json().catch(() => ({}))
  const newRole: Role | null =
    body.role === "admin" || body.role === "member" ? body.role : null
  if (!newRole) {
    return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 })
  }

  const { data, error } = await supabase.rpc("set_user_role", {
    p_target_user_id: userId,
    p_new_role: newRole,
  })
  if (error) {
    console.error("[team/members PATCH] RPC error", error)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }

  const result = (data ?? [])[0] as { success: boolean; error_code: string | null } | undefined
  if (!result?.success) {
    const m = mapError(result?.error_code)
    return NextResponse.json({ error: m.msg }, { status: m.status })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const { userId } = await params

  const { data, error } = await supabase.rpc("remove_user_from_company", {
    p_target_user_id: userId,
  })
  if (error) {
    console.error("[team/members DELETE] RPC error", error)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }

  const result = (data ?? [])[0] as { success: boolean; error_code: string | null } | undefined
  if (!result?.success) {
    const m = mapError(result?.error_code)
    return NextResponse.json({ error: m.msg }, { status: m.status })
  }

  // ADR-020: clear any field-role project grants for the removed user. Their
  // user_id FKs auth.users (which survives removal), so without this the rows
  // would linger as stale grants. Best-effort — a removed profile already
  // means has_project_module_access() returns false for them regardless.
  const { error: paErr } = await supabase.from("project_access").delete().eq("user_id", userId)
  if (paErr) console.warn("[team/members DELETE] project_access cleanup failed", paErr)

  return NextResponse.json({ ok: true })
}
