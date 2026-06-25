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

export function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 })
}
