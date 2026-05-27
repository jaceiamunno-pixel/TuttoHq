import { NextRequest, NextResponse } from "next/server"
import { createClient as createServiceClient } from "@supabase/supabase-js"
import { runRemindersForKind } from "@/lib/reminders"

// ─── /api/cron/send-reminders ───────────────────────────────────────────────
// Vercel Cron entrypoint — fires daily per vercel.json. Authenticates the
// request by matching the `Authorization: Bearer ${CRON_SECRET}` header that
// Vercel's cron runner injects automatically when CRON_SECRET is set in the
// project's env vars. Anything that doesn't carry the right secret gets a
// flat 401 — defense against random scanners hitting a known cron path.
//
// The route is allow-listed in src/middleware.ts so unauthenticated traffic
// isn't redirected to /login before we get a chance to verify the bearer.
//
// Uses the service-role client so RLS doesn't gate read access to packages
// across companies. The reminders.ts runner sets company_id explicitly on
// every insert (gmail_*_reminders.company_id is NOT NULL precisely because
// the DEFAULT resolves to NULL under service-role).

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  // Bearer-token check. Vercel Cron sends `Authorization: Bearer <secret>`.
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error("[cron/send-reminders] FAIL CRON_SECRET not configured")
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }
  const header = req.headers.get("authorization") ?? ""
  if (header !== `Bearer ${expected}`) return unauthorized()

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[cron/send-reminders] FAIL Supabase env not set")
    return NextResponse.json({ error: "Supabase env not configured" }, { status: 500 })
  }

  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  // Both package types share the same runner; each returns its own report
  // so we can spot a type-specific failure (e.g. PDF composer regression on
  // one but not the other) from the cron's exit JSON without trawling logs.
  const [submittalReport, closeoutReport] = await Promise.all([
    runRemindersForKind(supabase, "submittal"),
    runRemindersForKind(supabase, "closeout"),
  ])

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    submittal: submittalReport,
    closeout:  closeoutReport,
  })
}
