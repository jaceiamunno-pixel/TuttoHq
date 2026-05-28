import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { validateSettingsBody } from "@/lib/reminder-settings"

// ─── PATCH /api/submittal-packages/[id]/settings (Session K2) ───────────────
// Edit reminder settings for a package. Lives on a separate route from the
// main PATCH so we can allow edits regardless of status — settings need to
// be tweakable AFTER dispatch (that's literally when they matter), while
// the main PATCH keeps its draft-only invariant for scalar fields + items.
//
// Auth-cookie client only; RLS enforces ownership via company_id. No admin
// client needed — this isn't a presigned-upload path.

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  // Existence check doubles as the ownership check — RLS hides packages
  // outside the user's company, so a 404 here is "not yours" or "not real".
  const { data: pkg } = await supabase
    .from("submittal_packages")
    .select("id")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })

  const validated = validateSettingsBody(body)
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  if (Object.keys(validated.value).length === 0) {
    return NextResponse.json({ error: "No settings fields provided" }, { status: 400 })
  }

  const { error } = await supabase
    .from("submittal_packages")
    .update(validated.value)
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
