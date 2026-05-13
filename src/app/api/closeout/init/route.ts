import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Universal items that apply to every project regardless of submittals
const UNIVERSAL_ITEMS = [
  // ── Inspections ───────────────────────────────────────────────────────────────
  { category: "inspections", item_type: "inspection", title: "Certificate of Occupancy",        sort_order: 200 },
  { category: "inspections", item_type: "inspection", title: "Final Building Inspection",       sort_order: 201 },
  { category: "inspections", item_type: "inspection", title: "Final Electrical Inspection",     sort_order: 202 },
  { category: "inspections", item_type: "inspection", title: "Final Plumbing Inspection",       sort_order: 203 },
  { category: "inspections", item_type: "inspection", title: "Final Mechanical Inspection",     sort_order: 204 },
  { category: "inspections", item_type: "inspection", title: "Final Fire Inspection",           sort_order: 205 },
  // ── Financial ────────────────────────────────────────────────────────────────
  { category: "financial",   item_type: "lien_waiver", title: "Lien Waiver — General Contractor", sort_order: 300 },
  { category: "financial",   item_type: "payment",     title: "Final Payment Application",        sort_order: 310 },
  // ── Handover ─────────────────────────────────────────────────────────────────
  { category: "handover",    item_type: "keys",        title: "Keys, Access Cards & Credentials",    sort_order: 400 },
  { category: "handover",    item_type: "spare_parts", title: "Spare Parts & Maintenance Materials", sort_order: 401 },
  { category: "handover",    item_type: "emergency",   title: "Emergency Contact Sheet",             sort_order: 402 },
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

  // Fetch all active submittals for this project
  const { data: submittals } = await supabase
    .from("submittals")
    .select("id, file_name, csi_section")
    .eq("project_id", project_id)
    .eq("status", "active")
    .order("csi_section")

  const rows: object[] = []

  // For each submittal generate O&M, Warranty, and Attic Stock items
  // Strip file extension for cleaner titles
  let sortIdx = 0
  for (const sub of submittals ?? []) {
    const label = sub.file_name?.replace(/\.[^.]+$/, "") ?? sub.csi_section ?? "Unknown"
    const base = {
      project_id,
      status: "incomplete",
      uploaded_by: user.id,
      linked_record_id: sub.id,
      linked_record_type: "submittal",
    }
    rows.push({ ...base, category: "documents", item_type: "om_manual",   title: `O&M Manual — ${label}`,   sort_order: sortIdx++ })
    rows.push({ ...base, category: "documents", item_type: "warranty",    title: `Warranty — ${label}`,     sort_order: sortIdx++ })
    rows.push({ ...base, category: "documents", item_type: "attic_stock", title: `Attic Stock — ${label}`,  sort_order: sortIdx++ })
  }

  // Add universal items
  for (const item of UNIVERSAL_ITEMS) {
    rows.push({ ...item, project_id, status: "incomplete", uploaded_by: user.id })
  }

  const { error } = await supabase.from("closeout_items").insert(rows)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, generated: rows.length, from_submittals: (submittals ?? []).length })
}
