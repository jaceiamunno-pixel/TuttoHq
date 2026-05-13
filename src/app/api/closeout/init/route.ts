import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const DOC_ITEMS = [
  { item_type: "om_manual",     title: "O&M Manual — Mechanical (HVAC)",        sort_order: 10 },
  { item_type: "om_manual",     title: "O&M Manual — Electrical",               sort_order: 11 },
  { item_type: "om_manual",     title: "O&M Manual — Plumbing",                 sort_order: 12 },
  { item_type: "om_manual",     title: "O&M Manual — Fire Protection",          sort_order: 13 },
  { item_type: "om_manual",     title: "O&M Manual — Roofing System",           sort_order: 14 },
  { item_type: "startup",       title: "Start-Up Report — HVAC System",         sort_order: 20 },
  { item_type: "startup",       title: "Start-Up Report — Plumbing",            sort_order: 21 },
  { item_type: "startup",       title: "Start-Up Report — Electrical",          sort_order: 22 },
  { item_type: "startup",       title: "Start-Up Report — Fire Suppression",    sort_order: 23 },
  { item_type: "commissioning", title: "Commissioning Report — HVAC System",    sort_order: 30 },
  { item_type: "commissioning", title: "Commissioning Report — Electrical",     sort_order: 31 },
  { item_type: "commissioning", title: "Commissioning Report — Fire Suppression", sort_order: 32 },
]

const INSPECTION_ITEMS = [
  { item_type: "inspection", title: "Certificate of Occupancy",           sort_order: 200 },
  { item_type: "inspection", title: "Final Building Inspection",          sort_order: 201 },
  { item_type: "inspection", title: "Final Electrical Inspection",        sort_order: 202 },
  { item_type: "inspection", title: "Final Plumbing Inspection",          sort_order: 203 },
  { item_type: "inspection", title: "Final Mechanical Inspection",        sort_order: 204 },
  { item_type: "inspection", title: "Final Fire Inspection",              sort_order: 205 },
]

const TRAINING_ITEMS = [
  { item_type: "training", title: "Owner Training — HVAC System",              sort_order: 500 },
  { item_type: "training", title: "Owner Training — Electrical System",        sort_order: 501 },
  { item_type: "training", title: "Owner Training — Plumbing System",          sort_order: 502 },
  { item_type: "training", title: "Owner Training — Fire Safety Systems",      sort_order: 503 },
  { item_type: "training", title: "Owner Training — Security & Access Control", sort_order: 504 },
  { item_type: "training", title: "Owner Training — Building Systems Overview", sort_order: 505 },
]

const HANDOVER_ITEMS = [
  { item_type: "substantial_completion", title: "Certificate of Substantial Completion", sort_order: 600 },
  { item_type: "attic_stock",            title: "Attic Stock Confirmation",             sort_order: 601 },
  { item_type: "contact_sheet",          title: "Subcontractor Contact Sheet",          sort_order: 602 },
  { item_type: "keys",                   title: "Keys, Access Cards & Credentials",     sort_order: 603 },
  { item_type: "spare_parts",            title: "Spare Parts & Maintenance Materials",  sort_order: 604 },
  { item_type: "emergency",              title: "Emergency Contact Sheet",              sort_order: 605 },
]

const WARRANTY_EQUIPMENT = [
  { item_type: "manufacturer_warranty", title: "Manufacturer Warranty — HVAC Equipment",     notes: "Manufacturer", sort_order: 710 },
  { item_type: "manufacturer_warranty", title: "Manufacturer Warranty — Roofing System",     notes: "Manufacturer", sort_order: 711 },
  { item_type: "manufacturer_warranty", title: "Manufacturer Warranty — Glazing & Windows",  notes: "Manufacturer", sort_order: 712 },
  { item_type: "manufacturer_warranty", title: "Manufacturer Warranty — Elevator Equipment", notes: "Manufacturer", sort_order: 713 },
]

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

  // Documents — O&M, start-up, commissioning
  for (const d of DOC_ITEMS) rows.push({ ...base, category: "documents", ...d })

  // Inspections
  for (const d of INSPECTION_ITEMS) rows.push({ ...base, category: "inspections", ...d })

  // Financial — per sub: conditional lien waiver, unconditional lien waiver, final pay app
  let finIdx = 300
  for (const m of team ?? []) {
    const sub = m.title ? `${m.name} (${m.title})` : m.name
    rows.push({ ...base, category: "financial", item_type: "lien_waiver_conditional",   title: `Conditional Lien Waiver — ${sub}`,   assigned_to: m.name, notes: "Conditional",   sort_order: finIdx++ })
    rows.push({ ...base, category: "financial", item_type: "lien_waiver_unconditional", title: `Unconditional Lien Waiver — ${sub}`, assigned_to: m.name, notes: "Unconditional", sort_order: finIdx++ })
    rows.push({ ...base, category: "financial", item_type: "final_pay_app",             title: `Final Pay Application — ${sub}`,     assigned_to: m.name,                          sort_order: finIdx++ })
  }
  // Universal financial items
  rows.push({ ...base, category: "financial", item_type: "retainage", title: "Retainage Release Confirmation", sort_order: 395 })

  // Training
  for (const d of TRAINING_ITEMS) rows.push({ ...base, category: "training", ...d })

  // Handover
  for (const d of HANDOVER_ITEMS) rows.push({ ...base, category: "handover", ...d })

  // Warranties — workmanship per sub
  let warIdx = 700
  for (const m of team ?? []) {
    const sub = m.title ? `${m.name} (${m.title})` : m.name
    rows.push({ ...base, category: "warranties", item_type: "workmanship_warranty", title: `Workmanship Warranty — ${sub}`, assigned_to: m.name, notes: "1-Year Workmanship", sort_order: warIdx++ })
  }
  // Manufacturer warranties for standard equipment
  for (const d of WARRANTY_EQUIPMENT) rows.push({ ...base, category: "warranties", ...d })

  const { error } = await supabase.from("closeout_items").insert(rows)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, generated: rows.length })
}
