import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

// The shared, read-only demo company (companies.is_demo = true), seeded in prod
// with two fake projects. Demo visitors don't get their own company — they join
// this one as throwaway role='demo' users, which migrations 0026/0027 make
// read-only at the DB and enforceAiLimit() blocks off the cost routes.
const DEMO_COMPANY_ID = "00000000-0000-4000-a000-0000000000d0"

// POST /api/demo — provision an anonymous demo user and sign them in.
//
// One-click entry from the landing CTA: no form, no inputs. We mint a throwaway
// auth user, attach it to the existing demo company as role='demo', and
// establish a real cookie session with the SAME primitive normal login uses
// (signInWithPassword through the @supabase/ssr client — here server-side,
// because we generated the password, so it never reaches the browser).
export async function POST() {
  const admin = createAdminClient()

  // Random, unguessable throwaway credentials. The password is used once, here,
  // and is never returned to the client. Two UUIDs + a fixed complexity token
  // clear any GoTrue password policy that may be enabled.
  const email = `demo+${crypto.randomUUID()}@tuttohq.com`
  const password = `${crypto.randomUUID()}${crypto.randomUUID()}Aa1!`

  // Create the auth user with email pre-confirmed so sign-in works immediately.
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Demo User", is_demo: true },
  })

  if (authError || !authData?.user) {
    console.error("demo: createUser failed:", authError)
    return NextResponse.json({ error: "Could not start demo" }, { status: 500 })
  }

  const userId = authData.user.id

  // Map the user → demo company so get_my_company_id() / get_my_role() resolve
  // to the demo tenant and is_demo_user() returns true.
  // INVARIANT: user_profiles writes MUST use the admin (service-role) client —
  // the table's RLS allows SELECT-own-row only; regular-client writes hit 0 rows.
  // NOTE: full_name is NOT a user_profiles column (it lives in user_metadata,
  // above) — the row is exactly { user_id, company_id, role }.
  const { error: profileError } = await admin.from("user_profiles").insert({
    user_id: userId,
    company_id: DEMO_COMPANY_ID,
    role: "demo",
  })

  if (profileError) {
    // Roll back the auth user (cascades the profile) so a failed provision
    // never leaves an orphaned account. Mirrors the signup route's cleanup.
    console.error("demo: user_profiles insert failed:", profileError)
    await admin.auth.admin.deleteUser(userId)
    return NextResponse.json({ error: "Could not start demo" }, { status: 500 })
  }

  // Establish the session the same way login does: signInWithPassword through
  // the ssr client. On the server this route handler can write cookies, so the
  // Set-Cookie lands on this POST's response and the visitor is authenticated
  // for the subsequent navigation to /dashboard.
  const supabase = await createClient()
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

  if (signInError) {
    // Session never established — roll back so we don't strand a demo account.
    console.error("demo: signInWithPassword failed:", signInError)
    await admin.auth.admin.deleteUser(userId)
    return NextResponse.json({ error: "Could not start demo" }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
