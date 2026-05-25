import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// ─── Closeout packages — collection (Session K1) ────────────────────────────
// GET  /api/closeout-packages?project_id=…  — list packages for a project,
//        each with item_count / received_count / needs_review_count aggregates.
// POST /api/closeout-packages               — create a draft package.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pkg = Record<string, any>

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = new URL(req.url).searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data: packages, error } = await supabase
    .from("closeout_packages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const pkgList = (packages ?? []) as Pkg[]
  const ids = pkgList.map(p => p.id)
  if (ids.length === 0) return NextResponse.json({ packages: [] })

  // Items per package + completion state of each linked closeout_item.
  const { data: items } = await supabase
    .from("closeout_package_items")
    .select("package_id, closeout_item_id, closeout_items(status)")
    .in("package_id", ids)

  // Pending inbound rows are the "needs review" replies the PM hasn't placed.
  const { data: inbound } = await supabase
    .from("closeout_package_inbound")
    .select("package_id, status")
    .in("package_id", ids)
    .eq("status", "pending")

  const itemCount = new Map<string, number>()
  const receivedCount = new Map<string, number>()
  for (const it of (items ?? []) as Pkg[]) {
    itemCount.set(it.package_id, (itemCount.get(it.package_id) ?? 0) + 1)
    if (it.closeout_items?.status === "complete") {
      receivedCount.set(it.package_id, (receivedCount.get(it.package_id) ?? 0) + 1)
    }
  }

  const needsReviewCount = new Map<string, number>()
  for (const row of (inbound ?? []) as Pkg[]) {
    needsReviewCount.set(row.package_id, (needsReviewCount.get(row.package_id) ?? 0) + 1)
  }

  return NextResponse.json({
    packages: pkgList.map(p => ({
      ...p,
      item_count: itemCount.get(p.id) ?? 0,
      received_count: receivedCount.get(p.id) ?? 0,
      needs_review_count: needsReviewCount.get(p.id) ?? 0,
    })),
  })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const {
    project_id, vendor_id, vendor_type, vendor_name, sent_to_email,
    due_date, notes, closeout_item_ids,
  } = body as {
    project_id?: string
    vendor_id?: string | null
    vendor_type?: string | null
    vendor_name?: string
    sent_to_email?: string
    due_date?: string | null
    notes?: string | null
    closeout_item_ids?: string[]
  }

  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!vendor_name?.trim()) return NextResponse.json({ error: "A vendor name is required" }, { status: 400 })
  if (!sent_to_email?.trim() || !EMAIL_RE.test(sent_to_email.trim())) {
    return NextResponse.json({ error: "A valid recipient email is required" }, { status: 400 })
  }
  if (!Array.isArray(closeout_item_ids) || closeout_item_ids.length === 0) {
    return NextResponse.json({ error: "Select at least one closeout item to package" }, { status: 400 })
  }
  if (vendor_type && vendor_type !== "subcontractor" && vendor_type !== "supplier") {
    return NextResponse.json({ error: "Invalid vendor_type" }, { status: 400 })
  }

  // All items must belong to the target project (no cross-project packages).
  const { data: itemRows, error: itemErr } = await supabase
    .from("closeout_items")
    .select("id")
    .in("id", closeout_item_ids)
    .eq("project_id", project_id)
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 })
  const validIds = (itemRows ?? []).map(r => r.id)
  if (validIds.length === 0) {
    return NextResponse.json({ error: "None of the selected items belong to this project" }, { status: 400 })
  }

  // Allocate the per-project package number → TTQ-CO-{short_id}-{seq}.
  const { data: projectRow, error: projErr } = await supabase
    .from("projects")
    .select("short_id")
    .eq("id", project_id)
    .maybeSingle()
  if (projErr || !projectRow) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  const { data: seq, error: seqErr } = await supabase.rpc("next_closeout_package_seq", { p_project_id: project_id })
  if (seqErr || typeof seq !== "number") {
    return NextResponse.json({ error: seqErr?.message ?? "Could not allocate a package number" }, { status: 500 })
  }
  const shortId = projectRow.short_id || project_id.replace(/-/g, "").slice(0, 4).toUpperCase()
  const packageNumber = `TTQ-CO-${shortId}-${seq}`

  const { data: pkg, error: insErr } = await supabase
    .from("closeout_packages")
    .insert({
      project_id,
      package_number: packageNumber,
      vendor_id: vendor_id || null,
      vendor_type: vendor_type || null,
      vendor_name_snapshot: vendor_name.trim(),
      sent_to_email: sent_to_email.trim(),
      due_date: due_date || null,
      notes: notes?.trim() || null,
      status: "draft",
      created_by: user.id,
    })
    .select()
    .single()
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  const { error: junctionErr } = await supabase
    .from("closeout_package_items")
    .insert(validIds.map(cid => ({ package_id: pkg.id, closeout_item_id: cid })))
  if (junctionErr) {
    // Roll back the package so we don't leave an empty draft behind.
    await supabase.from("closeout_packages").delete().eq("id", pkg.id)
    return NextResponse.json({ error: junctionErr.message }, { status: 500 })
  }

  return NextResponse.json({ package: { ...pkg, item_count: validIds.length } }, { status: 201 })
}
