import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { composeRfqPackagePdf } from "@/lib/rfq-package-pdf"

export const maxDuration = 60

// GET /api/rfq/[id]/package — re-sign the already-generated package PDF (used by
// the Send handoff to hand the estimator a fresh download link to attach).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: rfq } = await supabase.from("rfqs").select("package_pdf_path").eq("id", id).maybeSingle()
  if (!rfq) return NextResponse.json({ error: "RFQ not found" }, { status: 404 })
  if (!rfq.package_pdf_path) return NextResponse.json({ url: null })

  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(rfq.package_pdf_path, 604800)
  return NextResponse.json({ url: signed?.signedUrl ?? null })
}

// POST /api/rfq/[id]/package — build the bid package PDF from the selected spec
// sections (by spec_number) + drawing sheets, store it company-scoped, persist
// rfqs.package_pdf_path, and return a 7-day signed URL. Selection is passed in
// the body (ephemeral) — v1a doesn't persist the section/sheet picks, so re-pick
// to regenerate.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Ownership check for a clean 404 (compose also re-reads RLS-scoped).
  const { data: rfq } = await supabase.from("rfqs").select("id").eq("id", id).maybeSingle()
  if (!rfq) return NextResponse.json({ error: "RFQ not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const specNumbers: string[] = Array.isArray(body?.specNumbers) ? body.specNumbers.map(String) : []
  const sheetIds: string[] = Array.isArray(body?.sheetIds) ? body.sheetIds.map(String) : []
  if (specNumbers.length === 0 && sheetIds.length === 0) {
    return NextResponse.json({ error: "Select at least one spec section or drawing sheet" }, { status: 400 })
  }

  try {
    const { storagePath } = await composeRfqPackagePdf(supabase, id, { specNumbers, sheetIds }, Date.now())
    await supabase.from("rfqs").update({ package_pdf_path: storagePath }).eq("id", id)
    const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(storagePath, 604800)
    return NextResponse.json({ ok: true, package_pdf_path: storagePath, url: signed?.signedUrl ?? null })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to build package"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
