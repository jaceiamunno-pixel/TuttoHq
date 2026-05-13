import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const DEFAULT_ITEMS = [
  // ── Documents ────────────────────────────────────────────────────────────────
  { category: "documents", item_type: "om_manual",   title: "O&M Manual — HVAC System",                sort_order: 10 },
  { category: "documents", item_type: "om_manual",   title: "O&M Manual — Plumbing System",            sort_order: 11 },
  { category: "documents", item_type: "om_manual",   title: "O&M Manual — Electrical System",          sort_order: 12 },
  { category: "documents", item_type: "om_manual",   title: "O&M Manual — Fire Suppression System",    sort_order: 13 },
  { category: "documents", item_type: "om_manual",   title: "O&M Manual — Roofing System",             sort_order: 14 },
  { category: "documents", item_type: "warranty",    title: "Warranty — Contractor (1-Year General)",  sort_order: 20 },
  { category: "documents", item_type: "warranty",    title: "Warranty — Roofing (Manufacturer)",       sort_order: 21 },
  { category: "documents", item_type: "warranty",    title: "Warranty — HVAC Equipment",               sort_order: 22 },
  { category: "documents", item_type: "warranty",    title: "Warranty — Glazing & Windows",            sort_order: 23 },
  { category: "documents", item_type: "attic_stock", title: "Attic Stock Confirmation",                sort_order: 30 },
  // ── Inspections ───────────────────────────────────────────────────────────────
  { category: "inspections", item_type: "inspection", title: "Certificate of Occupancy",               sort_order: 40 },
  { category: "inspections", item_type: "inspection", title: "Final Building Inspection",              sort_order: 41 },
  { category: "inspections", item_type: "inspection", title: "Final Electrical Inspection",            sort_order: 42 },
  { category: "inspections", item_type: "inspection", title: "Final Plumbing Inspection",              sort_order: 43 },
  { category: "inspections", item_type: "inspection", title: "Final Mechanical Inspection",            sort_order: 44 },
  { category: "inspections", item_type: "inspection", title: "Final Fire Inspection",                  sort_order: 45 },
  // ── Financial ────────────────────────────────────────────────────────────────
  { category: "financial", item_type: "lien_waiver",  title: "Lien Waiver — General Contractor",      sort_order: 50 },
  { category: "financial", item_type: "lien_waiver",  title: "Lien Waiver — Structural Sub",          sort_order: 51 },
  { category: "financial", item_type: "lien_waiver",  title: "Lien Waiver — Mechanical Sub",          sort_order: 52 },
  { category: "financial", item_type: "lien_waiver",  title: "Lien Waiver — Electrical Sub",          sort_order: 53 },
  { category: "financial", item_type: "lien_waiver",  title: "Lien Waiver — Plumbing Sub",            sort_order: 54 },
  { category: "financial", item_type: "payment",      title: "Final Payment Application",             sort_order: 55 },
  // ── Training ─────────────────────────────────────────────────────────────────
  { category: "training", item_type: "training",      title: "Owner Training — HVAC System",          sort_order: 60 },
  { category: "training", item_type: "training",      title: "Owner Training — Security & Access Control", sort_order: 61 },
  { category: "training", item_type: "training",      title: "Owner Training — Building Systems Overview", sort_order: 62 },
  { category: "training", item_type: "training",      title: "Owner Training — Fire Safety Systems",  sort_order: 63 },
  // ── Handover ─────────────────────────────────────────────────────────────────
  { category: "handover", item_type: "keys",          title: "Keys, Access Cards & Credentials",      sort_order: 70 },
  { category: "handover", item_type: "spare_parts",   title: "Spare Parts & Maintenance Materials",   sort_order: 71 },
  { category: "handover", item_type: "emergency",     title: "Emergency Contact Sheet",               sort_order: 72 },
]

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { project_id } = await req.json()
  if (!project_id) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  // Only init if no items exist yet
  const { count } = await supabase
    .from("closeout_items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project_id)

  if ((count ?? 0) > 0) return NextResponse.json({ ok: true, skipped: true })

  const rows = DEFAULT_ITEMS.map(item => ({
    ...item,
    project_id,
    status: "incomplete",
    uploaded_by: user.id,
  }))

  const { error } = await supabase.from("closeout_items").insert(rows)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
