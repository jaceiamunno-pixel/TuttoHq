import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { validateSettingsBody } from "@/lib/reminder-settings"

// ─── PATCH /api/closeout-packages/[id]/settings (Session K2) ────────────────
// Twin of the submittal-package settings route. Same shape, same validation,
// same auth pattern — kept as a separate file so the two package types stay
// independently routable (matches the Session I / K1 split everywhere else).

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const { data: pkg } = await supabase
    .from("closeout_packages")
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
    .from("closeout_packages")
    .update(validated.value)
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
