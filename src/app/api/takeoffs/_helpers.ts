import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Shared server helpers for the Bid Takeoff routes (count-only pass).
//
// company_id: every tenant table here carries DEFAULT get_my_company_id() + an RLS
// WITH CHECK (company_id = get_my_company_id()) policy, exactly like submittals.
// We still resolve the caller's company from user_profiles and set company_id
// EXPLICITLY on every insert (belt-and-suspenders): the value equals
// get_my_company_id(), so RLS validates it; the client never sends company_id and
// can never write into another tenant. (See sql/migrations.sql get_my_company_id.)

type Supa = Awaited<ReturnType<typeof createClient>>

export interface Ctx {
  supabase: Supa
  userId: string
  /** The caller's company — resolved from user_profiles; set on every insert. */
  companyId: string
}

/** Authenticate + resolve company in one place. Returns a Ctx, or a NextResponse
 *  to return early (401 unauth / 403 no company). */
export async function getCtx(): Promise<Ctx | NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: prof } = await supabase
    .from("user_profiles").select("company_id").eq("user_id", user.id).maybeSingle()
  const companyId = (prof?.company_id as string | null | undefined) ?? null
  if (!companyId) return NextResponse.json({ error: "No company for user" }, { status: 403 })

  return { supabase, userId: user.id, companyId }
}

export function isResponse(x: Ctx | NextResponse): x is NextResponse {
  return x instanceof NextResponse
}

/** RLS-scoped existence check used by child-entity writes — a clean 404 instead
 *  of silently letting a row reference a takeoff in another tenant. */
export async function takeoffExists(supabase: Supa, takeoffId: string): Promise<boolean> {
  const { data } = await supabase
    .from("takeoffs").select("id").eq("id", takeoffId).maybeSingle()
  return !!data
}

/** Verify the caller's company owns this project (RLS-scoped read). */
export async function ownsProject(supabase: Supa, projectId: string): Promise<boolean> {
  const { data } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle()
  return !!data
}

/** Verify tag_id and room_id (when provided) both belong to the given takeoff.
 *  Closes the cross-takeoff reference hole RLS can't see (same company). */
export async function childBelongsToTakeoff(
  supabase: Supa, takeoffId: string,
  opts: { tagId?: string; roomId?: string; categoryId?: string }
): Promise<boolean> {
  const checks: PromiseLike<boolean>[] = []
  if (opts.tagId) checks.push(supabase.from("takeoff_tags").select("id").eq("id", opts.tagId).eq("takeoff_id", takeoffId).maybeSingle().then(r => !!r.data))
  if (opts.roomId) checks.push(supabase.from("takeoff_rooms").select("id").eq("id", opts.roomId).eq("takeoff_id", takeoffId).maybeSingle().then(r => !!r.data))
  if (opts.categoryId) checks.push(supabase.from("takeoff_categories").select("id").eq("id", opts.categoryId).eq("takeoff_id", takeoffId).maybeSingle().then(r => !!r.data))
  const results = await Promise.all(checks)
  return results.every(Boolean)
}

export function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 })
}
