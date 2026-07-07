import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Add one or more recipients to an RFQ. Body: { recipients: [{ vendor_id,
// vendor_person_id? }] } or a single { vendor_id, vendor_person_id? }.
//
// Tenant isolation (the careful part):
//   1. The parent RFQ is fetched RLS-scoped — a caller who doesn't own it gets
//      404, so recipients can never be grafted onto another company's RFQ.
//   2. Each vendor_id is validated against an RLS-scoped vendors read — only the
//      caller's own vendors survive; unknown/foreign ids are dropped.
//   3. company_id is stamped explicitly to the RFQ's company (belt + suspenders
//      on top of the column DEFAULT + RLS WITH CHECK).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: rfqId } = await params

  // 1. Ownership check — RLS-scoped fetch of the parent RFQ.
  const { data: rfq } = await supabase
    .from("rfqs").select("id, company_id").eq("id", rfqId).maybeSingle()
  if (!rfq) return NextResponse.json({ error: "RFQ not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const raw: { vendor_id?: string; vendor_person_id?: string | null }[] = Array.isArray(body?.recipients)
    ? body.recipients
    : body?.vendor_id ? [{ vendor_id: body.vendor_id, vendor_person_id: body.vendor_person_id ?? null }] : []

  const requested = raw
    .map(r => ({ vendor_id: String(r.vendor_id ?? "").trim(), vendor_person_id: r.vendor_person_id?.trim?.() || null }))
    .filter(r => r.vendor_id)
  if (requested.length === 0) return NextResponse.json({ error: "No vendors given" }, { status: 400 })

  // 2. Validate vendor_ids against the caller's own vendors master (RLS-scoped).
  const vendorIds = [...new Set(requested.map(r => r.vendor_id))]
  const { data: ownedVendors } = await supabase.from("vendors").select("id").in("id", vendorIds)
  const ownedSet = new Set((ownedVendors ?? []).map(v => v.id))

  // Skip vendors already on this RFQ (idempotent multi-select re-adds).
  const { data: existing } = await supabase
    .from("rfq_recipients").select("vendor_id").eq("rfq_id", rfqId)
  const existingSet = new Set((existing ?? []).map(r => r.vendor_id))

  const sentAt = new Date().toISOString()
  const toInsert = requested
    .filter(r => ownedSet.has(r.vendor_id) && !existingSet.has(r.vendor_id))
    .map(r => ({
      rfq_id:           rfqId,
      company_id:       rfq.company_id,
      vendor_id:        r.vendor_id,
      vendor_person_id: r.vendor_person_id,
      state:            "sent",
      sent_at:          sentAt,
    }))

  if (toInsert.length === 0) return NextResponse.json({ ok: true, added: 0 })

  const { error } = await supabase.from("rfq_recipients").insert(toInsert)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, added: toInsert.length })
}
