import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/rfq/[id]/recipients/[rid]/quote — sign the recipient's uploaded quote
// PDF for viewing. The recipient row is fetched RLS-scoped (and matched to the
// route's rfq_id), so a caller can only ever sign a quote in their own tenant.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: rfqId, rid } = await params
  const { data: row } = await supabase
    .from("rfq_recipients").select("quote_file_path").eq("id", rid).eq("rfq_id", rfqId).maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!row.quote_file_path) return NextResponse.json({ url: null })

  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(row.quote_file_path, 604800)
  return NextResponse.json({ url: signed?.signedUrl ?? null })
}
