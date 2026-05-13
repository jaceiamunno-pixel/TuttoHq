import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createClient as createServiceClient } from "@supabase/supabase-js"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = ["review_status", "csi_division", "division_name", "csi_section", "section_name", "project_id"]
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  // Auto-flag when a user manually changes the CSI classification
  if ("csi_division" in safe || "csi_section" in safe) {
    safe.manually_overridden = true
    safe.overridden_by = user.id
  }

  const { error } = await supabase.from("submittals").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Verify the user is authenticated first
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Use service role to bypass RLS for the soft-delete update
  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { error } = await admin
    .from("submittals")
    .update({ status: "deleted" })
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
