import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { num } from "@/lib/po-helpers"

// Invoices drawn against a PO (commitment_invoices). RLS + company_id default
// scope these to the tenant; we still confirm the parent PO for a clean 404.
// retainage_amount is NOT exposed for POs — it defaults to 0 in the schema.

const STATUSES = ["draft", "submitted", "paid"] as const
type InvoiceStatus = typeof STATUSES[number]
const isStatus = (v: unknown): v is InvoiceStatus => typeof v === "string" && (STATUSES as readonly string[]).includes(v)

async function poExists(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data } = await supabase.from("commitments").select("id").eq("id", id).eq("type", "purchase_order").maybeSingle()
  return !!data
}

// GET /api/purchase-orders/[id]/invoices — newest first.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!(await poExists(supabase, id))) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 })

  const { data, error } = await supabase
    .from("commitment_invoices")
    .select("id, invoice_no, invoice_date, amount, retainage_amount, status, created_at")
    .eq("commitment_id", id)
    .order("invoice_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ invoices: data ?? [] })
}

// POST /api/purchase-orders/[id]/invoices — add an invoice.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!(await poExists(supabase, id))) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const amount = num(body.amount)
  if (amount == null || amount < 0) return NextResponse.json({ error: "A non-negative amount is required" }, { status: 400 })

  const { data: row, error } = await supabase
    .from("commitment_invoices")
    .insert({
      commitment_id: id,
      invoice_no: typeof body.invoice_no === "string" ? body.invoice_no.trim() || null : null,
      invoice_date: typeof body.invoice_date === "string" ? body.invoice_date || null : null,
      amount,
      status: isStatus(body.status) ? body.status : "draft",
    })
    .select("id, invoice_no, invoice_date, amount, retainage_amount, status, created_at")
    .single()
  if (error || !row) return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 })
  return NextResponse.json({ invoice: row }, { status: 201 })
}
