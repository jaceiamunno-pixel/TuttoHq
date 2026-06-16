import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// PO number lifecycle, backed by the SECURITY DEFINER RPCs:
//   POST   → issue_po_number()        — reserve + return the next 'prefix||seq'
//   DELETE → release_po_number(n)      — roll the sequence back IF n was the last
//                                        issued (a no-op otherwise)
//
// A number is reserved the moment the user starts a new PO so it can be shown in
// the draft form; if they abandon the form before saving, the client releases it
// so the sequence recycles.

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase.rpc("issue_po_number")
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not issue PO number" }, { status: 500 })
  return NextResponse.json({ po_number: data as string })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const n = req.nextUrl.searchParams.get("n")?.trim()
  if (!n) return NextResponse.json({ error: "n (po_number) is required" }, { status: 400 })

  const { data, error } = await supabase.rpc("release_po_number", { p_number: n })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ released: data === true })
}
