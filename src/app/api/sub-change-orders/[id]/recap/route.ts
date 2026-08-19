import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computeSubCoRecap } from "@/lib/sub-co-shared"

// Read-only view of the CO form's right-hand recap column, produced by the SAME
// computeSubCoRecap() the PDF route uses — so the editor's preview and the
// printed page can never drift apart. No mutation, no snap_* write, therefore
// no forbidFieldRole write gate (RLS still hides the row from the field role).

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: sco, error } = await supabase
    .from("sub_change_orders")
    .select("*")
    .eq("id", id)
    .neq("status", "deleted")
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!sco) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const recap = await computeSubCoRecap(supabase, sco)
  return NextResponse.json({ recap })
}
