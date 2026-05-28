import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function POST(req: NextRequest) {
  const { fullName, companyName, email, password } = await req.json()

  if (!fullName?.trim() || !companyName?.trim() || !email?.trim() || !password) {
    return NextResponse.json({ error: "All fields are required" }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 })
  }

  const admin = createAdminClient()

  // Create auth user with email pre-confirmed (bypasses confirmation email)
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName.trim(), company_name: companyName.trim() },
  })

  if (authError) {
    const msg = authError.message.toLowerCase().includes("already")
      ? "An account with this email already exists."
      : authError.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const userId = authData.user.id

  // Create company record and capture the new company id
  const { data: companyRow, error: companyError } = await admin
    .from("companies")
    .insert({ name: companyName.trim(), owner_id: userId })
    .select("id")
    .single()

  if (companyError || !companyRow) {
    // Roll back auth user to avoid orphaned accounts
    await admin.auth.admin.deleteUser(userId)
    return NextResponse.json({ error: "Failed to create company" }, { status: 500 })
  }

  const companyId = companyRow.id

  // Map user → company so get_my_company_id() works for all RLS policies.
  // INVARIANT: user_profiles writes MUST use the admin (service-role) client.
  // The table's RLS allows SELECT-own-row only; regular-client writes silently
  // affect 0 rows. See the "user_profiles: select own" policy in migrations.sql.
  await admin.from("user_profiles").insert({ user_id: userId, company_id: companyId })

  // Add owner as a team member so they appear in RFI/report dropdowns
  // company_id is explicit here since this INSERT uses the service role (no auth context)
  await admin.from("team_members").insert({
    name:       fullName.trim(),
    email:      email.trim().toLowerCase(),
    title:      "Owner",
    company_id: companyId,
  })

  return NextResponse.json({ ok: true })
}
