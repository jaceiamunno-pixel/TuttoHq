import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: record } = await supabase
    .from("submittals")
    .select("storage_path")
    .eq("id", id)
    .single()

  if (record?.storage_path) {
    await supabase.storage.from("submittals").remove([record.storage_path])
  }

  const { error } = await supabase.from("submittals").delete().eq("id", id)

  if (error) {
    console.error("Delete failed:", error)
    return NextResponse.json({ error: "Delete failed" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
