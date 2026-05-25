import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // RLS-gated lookup: only returns the row if it belongs to the user's company.
  const { data: record, error: selErr } = await supabase
    .from("submittals")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (record.storage_path) {
    await supabase.storage.from("submittals").remove([record.storage_path])
  }

  const { error } = await supabase.from("submittals").delete().eq("id", id)

  if (error) {
    console.error("Delete failed:", error)
    return NextResponse.json({ error: "Delete failed" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
