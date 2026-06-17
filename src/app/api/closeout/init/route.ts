import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { project_id } = await req.json()
  if (!project_id) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  const { count } = await supabase
    .from("closeout_items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project_id)
  if ((count ?? 0) > 0) return NextResponse.json({ ok: true, skipped: true })

  const { data: team } = await supabase
    .from("team_members")
    .select("id, name, title")
    .order("name")

  const base = { project_id, status: "incomplete", uploaded_by: user.id }
  const rows: object[] = []

  // ── INSPECTIONS ───────────────────────────────────────────────────────────
  rows.push({ ...base, category: "inspections", item_type: "substantial_completion", title: "Certificate of Substantial Completion", sort_order: 200 })

  // ── WARRANTIES — single company warranty ─────────────────────────────────
  rows.push({ ...base, category: "warranties", item_type: "company_warranty", title: "Company Warranty", sort_order: 700 })

  // ── HANDOVER ──────────────────────────────────────────────────────────────
  rows.push({ ...base, category: "handover", item_type: "keys",          title: "Keys, Access Cards & Credentials",    sort_order: 600 })
  rows.push({ ...base, category: "handover", item_type: "attic_stock",   title: "Attic Stock Confirmation",            sort_order: 601 })
  rows.push({ ...base, category: "handover", item_type: "spare_parts",   title: "Spare Parts & Maintenance Materials", sort_order: 602 })
  rows.push({ ...base, category: "handover", item_type: "contact_sheet", title: "Subcontractor Contact Sheet",         sort_order: 603 })

  // Documents (As-Builts, Submittals, RFIs, COs) are pulled live from other modules.
  // O&M Manuals, Start-Up Reports, Commissioning Reports are added manually via + Add.
  // Training items are added manually via + Add.

  // ── SUBCONTRACTOR FOLDERS — one per project subcontractor ─────────────────
  // Unified vendors model: project_vendors (role='subcontractor') → vendors firm.
  const { data: projSubs } = await supabase
    .from("project_vendors")
    .select("vendors(id, company_name)")
    .eq("project_id", project_id)
    .eq("role", "subcontractor")

  let subIdx = 800
  for (const row of projSubs ?? []) {
    const sub = (Array.isArray(row.vendors) ? row.vendors[0] : row.vendors) as { id: string; company_name: string } | null
    if (!sub) continue
    const folder = sub.company_name
    rows.push({ ...base, category: "subcontractors", item_type: "workmanship_warranty",   title: "Workmanship Warranty",       folder_name: folder, sort_order: subIdx++ })
    rows.push({ ...base, category: "subcontractors", item_type: "lien_waiver_conditional",  title: "Conditional Lien Waiver",    folder_name: folder, sort_order: subIdx++ })
    rows.push({ ...base, category: "subcontractors", item_type: "lien_waiver_unconditional", title: "Unconditional Lien Waiver",  folder_name: folder, sort_order: subIdx++ })
    rows.push({ ...base, category: "subcontractors", item_type: "final_pay_app",            title: "Final Pay Application",      folder_name: folder, sort_order: subIdx++ })
    rows.push({ ...base, category: "subcontractors", item_type: "insurance_cert",           title: "Insurance Certificate",      folder_name: folder, sort_order: subIdx++ })
    rows.push({ ...base, category: "subcontractors", item_type: "contact_sheet",            title: "Subcontractor Contact Sheet", folder_name: folder, sort_order: subIdx++ })
  }

  // ── SUPPLIER FOLDERS — one per project supplier ───────────────────────────
  // Unified vendors model: project_vendors (role='supplier') → vendors firm.
  const { data: projSuppliers } = await supabase
    .from("project_vendors")
    .select("vendors(id, company_name)")
    .eq("project_id", project_id)
    .eq("role", "supplier")

  let supplIdx = 900
  for (const row of projSuppliers ?? []) {
    const suppl = (Array.isArray(row.vendors) ? row.vendors[0] : row.vendors) as { id: string; company_name: string } | null
    if (!suppl) continue
    const folder = suppl.company_name
    rows.push({ ...base, category: "suppliers", item_type: "material_warranty",   title: "Material Warranty",       folder_name: folder, sort_order: supplIdx++ })
    rows.push({ ...base, category: "suppliers", item_type: "om_manual",           title: "O&M Manual",              folder_name: folder, sort_order: supplIdx++ })
    rows.push({ ...base, category: "suppliers", item_type: "product_data_sheets", title: "Product Data Sheets",     folder_name: folder, sort_order: supplIdx++ })
    rows.push({ ...base, category: "suppliers", item_type: "contact_sheet",       title: "Supplier Contact Sheet",  folder_name: folder, sort_order: supplIdx++ })
  }

  const { error } = await supabase.from("closeout_items").insert(rows)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, generated: rows.length })
}
