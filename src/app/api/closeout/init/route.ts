import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

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

  // ── FINANCIAL — per sub + retainage ──────────────────────────────────────
  let finIdx = 300
  for (const m of team ?? []) {
    const sub = m.title ? `${m.name} (${m.title})` : m.name
    rows.push({ ...base, category: "financial", item_type: "lien_waiver_conditional",   title: `Conditional Lien Waiver — ${sub}`,   assigned_to: m.name, notes: "Conditional",   sort_order: finIdx++ })
    rows.push({ ...base, category: "financial", item_type: "lien_waiver_unconditional", title: `Unconditional Lien Waiver — ${sub}`, assigned_to: m.name, notes: "Unconditional", sort_order: finIdx++ })
    rows.push({ ...base, category: "financial", item_type: "final_pay_app",             title: `Final Pay Application — ${sub}`,     assigned_to: m.name,                          sort_order: finIdx++ })
  }
  rows.push({ ...base, category: "financial", item_type: "retainage", title: "Retainage Release Confirmation", sort_order: 395 })

  // ── WARRANTIES — workmanship per sub (manufacturer added manually) ────────
  let warIdx = 700
  for (const m of team ?? []) {
    const sub = m.title ? `${m.name} (${m.title})` : m.name
    rows.push({ ...base, category: "warranties", item_type: "workmanship_warranty", title: `Workmanship Warranty — ${sub}`, assigned_to: m.name, notes: "1-Year Workmanship", sort_order: warIdx++ })
  }

  // ── HANDOVER ──────────────────────────────────────────────────────────────
  rows.push({ ...base, category: "handover", item_type: "keys",          title: "Keys, Access Cards & Credentials",    sort_order: 600 })
  rows.push({ ...base, category: "handover", item_type: "attic_stock",   title: "Attic Stock Confirmation",            sort_order: 601 })
  rows.push({ ...base, category: "handover", item_type: "spare_parts",   title: "Spare Parts & Maintenance Materials", sort_order: 602 })
  rows.push({ ...base, category: "handover", item_type: "contact_sheet", title: "Subcontractor Contact Sheet",         sort_order: 603 })

  // Documents (As-Builts, Submittals, RFIs, COs) are pulled live from other modules.
  // O&M Manuals, Start-Up Reports, Commissioning Reports are added manually via + Add.
  // Training items are added manually via + Add.

  const { error } = await supabase.from("closeout_items").insert(rows)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, generated: rows.length })
}
