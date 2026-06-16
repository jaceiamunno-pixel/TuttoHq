import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { num } from "@/lib/po-helpers"

// Single invoice against a PO — edit / delete. RLS scopes to the tenant; we key
// on both commitment_id and id so an invoice can't be edited via the wrong PO.

const STATUSES = ["draft", "submitted", "paid"] as const
type InvoiceStatus = typeof STATUSES[number]
const isStatus = (v: unknown): v is InvoiceStatus => typeof v === "string" && (STATUSES as readonly string[]).includes(v)

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; invoiceId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, invoiceId } = await params
  const body = await req.json().catch(() => ({}))

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ("invoice_no" in body) update.invoice_no = typeof body.invoice_no === "string" ? body.invoice_no.trim() || null : null
  if ("invoice_date" in body) update.invoice_date = typeof body.invoice_date === "string" ? body.invoice_date || null : null
  if ("amount" in body) {
    const amount = num(body.amount)
    if (amount == null || amount < 0) return NextResponse.json({ error: "A non-negative amount is required" }, { status: 400 })
    update.amount = amount
  }
  if ("status" in body) {
    if (!isStatus(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    update.status = body.status
  }

  const { data: row, error } = await supabase
    .from("commitment_invoices")
    .update(update)
    .eq("id", invoiceId).eq("commitment_id", id)
    .select("id, invoice_no, invoice_date, amount, retainage_amount, status, created_at")
    .single()
  if (error || !row) return NextResponse.json({ error: error?.message ?? "Invoice not found" }, { status: error ? 500 : 404 })
  return NextResponse.json({ invoice: row })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; invoiceId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, invoiceId } = await params
  const { error } = await supabase.from("commitment_invoices").delete().eq("id", invoiceId).eq("commitment_id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
