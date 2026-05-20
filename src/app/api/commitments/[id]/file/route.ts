import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const SEVEN_DAYS = 60 * 60 * 24 * 7

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error } = await supabase
    .from("commitments")
    .select("executed_file_path, executed_file_name")
    .eq("id", id)
    .single()

  if (error || !row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!row.executed_file_path) return NextResponse.json({ error: "No file attached" }, { status: 404 })

  const { data: signed, error: signError } = await supabase.storage
    .from("submittals")
    .createSignedUrl(row.executed_file_path, SEVEN_DAYS)

  if (signError || !signed) {
    return NextResponse.json({ error: signError?.message ?? "Failed to sign URL" }, { status: 500 })
  }

  return NextResponse.json({ url: signed.signedUrl, file_name: row.executed_file_name })
}
