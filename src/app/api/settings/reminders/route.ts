import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  validateCompanyDefaultsBody,
  FALLBACK_CADENCE,
  FALLBACK_MAX_COUNT,
  FALLBACK_ATTACH_PDF,
} from "@/lib/reminder-settings"

// ─── /api/settings/reminders (Session K2) ────────────────────────────────────
// Company-wide reminder defaults. These ARE the inheritance target for the
// per-package overrides — there is nothing further to resolve against, so
// the GET returns raw values (or hardcoded fallbacks for the
// no-settings-row-yet case) and the PATCH rejects null on any field.
//
// Auth-cookie client throughout — RLS enforces ownership via the
// company_settings: company select / update / insert policies added in
// Phase 1. No admin client needed; this isn't a presigned-upload path.

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: row } = await supabase
    .from("company_settings")
    .select("reminder_cadence_days, reminder_max_count, reminder_default_attach_pdf")
    .maybeSingle()

  // A brand-new tenant with no company_settings row yet still needs sensible
  // defaults — return the same hardcoded fallbacks the cron and resolver use,
  // so the Settings page renders meaningful values even before the first save.
  return NextResponse.json({
    reminder_cadence_days:       row?.reminder_cadence_days       ?? FALLBACK_CADENCE,
    reminder_max_count:          row?.reminder_max_count          ?? FALLBACK_MAX_COUNT,
    reminder_default_attach_pdf: row?.reminder_default_attach_pdf ?? FALLBACK_ATTACH_PDF,
  })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const validated = validateCompanyDefaultsBody(body)
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  if (Object.keys(validated.value).length === 0) {
    return NextResponse.json({ error: "No settings fields provided" }, { status: 400 })
  }

  // UPSERT pattern mirrors /api/settings — one row per tenant, may not exist
  // yet on brand-new tenants. RLS filters the SELECT to this tenant only, so
  // a found row is guaranteed to be the right one.
  const { data: existing } = await supabase
    .from("company_settings")
    .select("id")
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from("company_settings")
      .update({ ...validated.value, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await supabase
      .from("company_settings")
      .insert(validated.value)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
