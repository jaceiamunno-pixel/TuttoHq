import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { recalcAndRead, snapshotDefaults, gcLineCostFields, num } from "@/lib/estimate-server"

// ADR-015 wire #1 — "Draft the bid": scaffold an estimate from the project's spec
// scope + the company GC template.
//
//  1. Snapshot company_bid_defaults into the estimate's own pct columns (a later
//     defaults edit never retro-alters this bid).
//  2. One estimate_line per IN-SCOPE project_scope_sections row, source='spec_book',
//     keyed by spec_number TEXT (LINKAGE LAW). spec_section_id is carried only as a
//     decorative convenience join; the bid survives a re-parse because it keys on
//     the stable spec_number string.
//  3. GC lines from active gc_template_items, source='gc_template'.
//  4. recalculate_estimate() — the ONLY producer of totals.
//
// Every insert stamps company_id explicitly (defense-in-depth over the column
// DEFAULT + RLS WITH CHECK). project_scope_sections / gc_template_items reads are
// RLS-scoped to the caller's company.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const projectId = typeof body.project_id === "string" ? body.project_id : ""
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Estimate"
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  // 1. Header — snapshot defaults.
  const snap = await snapshotDefaults(supabase)
  const { data: est, error: estErr } = await supabase
    .from("estimates")
    .insert({
      project_id: projectId,
      company_id: companyId,
      name,
      status: "draft",
      ...snap,
      permit_amount: 0,
      sqft: num(body.sqft),
      created_by: user.id,
    })
    .select("id")
    .single()
  if (estErr) return NextResponse.json({ error: estErr.message }, { status: 500 })

  // 2. In-scope spec sections → spec_book lines (spec_number TEXT linkage).
  const { data: scopeRows } = await supabase
    .from("project_scope_sections")
    .select("spec_number, spec_title, division_code, spec_section_id, in_scope")
    .eq("project_id", projectId)
    .eq("in_scope", true)
    .order("spec_number", { ascending: true })

  // 3. Active GC template rows → gc_template lines.
  const { data: gcRows } = await supabase
    .from("gc_template_items")
    .select("description, category, default_qty, default_unit, default_unit_cost, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("description", { ascending: true })

  const lines: Record<string, unknown>[] = []
  let order = 0

  for (const s of scopeRows ?? []) {
    lines.push({
      estimate_id: est.id,
      company_id: companyId,
      source: "spec_book",
      spec_number: s.spec_number ?? null,
      spec_section_id: s.spec_section_id ?? null, // decorative only (LINKAGE LAW)
      cost_code: null, // project_scope_sections carries no cost_code — estimator fills it
      description: s.spec_title ?? null,
      category: "other",
      sort_order: order++,
    })
  }

  for (const g of gcRows ?? []) {
    lines.push({
      estimate_id: est.id,
      company_id: companyId,
      source: "gc_template",
      description: g.description ?? null,
      category: g.category ?? "other",
      cost_code: null,
      ...gcLineCostFields(g),
      sort_order: order++,
    })
  }

  if (lines.length) {
    const { error: linesErr } = await supabase.from("estimate_lines").insert(lines)
    if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 })
  }

  // 4. Totals — server-side only.
  const { estimate, error: rErr } = await recalcAndRead(supabase, est.id)
  if (rErr) return NextResponse.json({ error: rErr }, { status: 500 })

  return NextResponse.json({
    id: est.id,
    estimate,
    scaffold: { spec_lines: (scopeRows ?? []).length, gc_lines: (gcRows ?? []).length },
  })
}
