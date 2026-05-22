import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// ─── Submittal packages — collection (Session I) ────────────────────────────
// GET  /api/submittal-packages?project_id=…  — list packages for a project,
//        each with item_count / received_count / needs_review_count aggregates.
// POST /api/submittal-packages               — create a draft package.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pkg = Record<string, any>

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = new URL(req.url).searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data: packages, error } = await supabase
    .from("submittal_packages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const pkgList = (packages ?? []) as Pkg[]
  const ids = pkgList.map(p => p.id)
  if (ids.length === 0) return NextResponse.json({ packages: [] })

  // Items per package + received state of each linked submittal.
  const { data: items } = await supabase
    .from("submittal_package_items")
    .select("package_id, submittal_id, submittals(received_date)")
    .in("package_id", ids)

  // Inbound replies tagged to these packages — orphans (not a package item)
  // are the "needs review" responses match-back could not auto-link.
  const { data: inbound } = await supabase
    .from("submittals")
    .select("id, received_via_package_id")
    .in("received_via_package_id", ids)
    .eq("status", "active")

  const itemCount = new Map<string, number>()
  const receivedCount = new Map<string, number>()
  const itemSubmittalIds = new Set<string>()
  for (const it of (items ?? []) as Pkg[]) {
    itemCount.set(it.package_id, (itemCount.get(it.package_id) ?? 0) + 1)
    itemSubmittalIds.add(it.submittal_id)
    if (it.submittals?.received_date) {
      receivedCount.set(it.package_id, (receivedCount.get(it.package_id) ?? 0) + 1)
    }
  }

  const needsReviewCount = new Map<string, number>()
  for (const row of (inbound ?? []) as Pkg[]) {
    if (itemSubmittalIds.has(row.id)) continue // auto-linked, not orphaned
    needsReviewCount.set(row.received_via_package_id, (needsReviewCount.get(row.received_via_package_id) ?? 0) + 1)
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
    due_date, notes, submittal_ids,
  } = body as {
    project_id?: string
    vendor_id?: string | null
    vendor_type?: string | null
    vendor_name?: string
    sent_to_email?: string
    due_date?: string | null
    notes?: string | null
    submittal_ids?: string[]
  }

  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!vendor_name?.trim()) return NextResponse.json({ error: "A vendor name is required" }, { status: 400 })
  if (!sent_to_email?.trim() || !EMAIL_RE.test(sent_to_email.trim())) {
    return NextResponse.json({ error: "A valid recipient email is required" }, { status: 400 })
  }
  if (!Array.isArray(submittal_ids) || submittal_ids.length === 0) {
    return NextResponse.json({ error: "Select at least one submittal to package" }, { status: 400 })
  }
  if (vendor_type && vendor_type !== "subcontractor" && vendor_type !== "supplier") {
    return NextResponse.json({ error: "Invalid vendor_type" }, { status: 400 })
  }

  // All submittals must belong to the target project (no cross-project packages).
  const { data: subRows, error: subErr } = await supabase
    .from("submittals")
    .select("id")
    .in("id", submittal_ids)
    .eq("project_id", project_id)
    .eq("status", "active")
  if (subErr) return NextResponse.json({ error: subErr.message }, { status: 500 })
  const validIds = (subRows ?? []).map(r => r.id)
  if (validIds.length === 0) {
    return NextResponse.json({ error: "None of the selected submittals belong to this project" }, { status: 400 })
  }

  // Allocate the per-project package number → TTQ-{short_id}-{seq}.
  const { data: projectRow, error: projErr } = await supabase
    .from("projects")
    .select("short_id")
    .eq("id", project_id)
    .maybeSingle()
  if (projErr || !projectRow) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  const { data: seq, error: seqErr } = await supabase.rpc("next_package_seq", { p_project_id: project_id })
  if (seqErr || typeof seq !== "number") {
    return NextResponse.json({ error: seqErr?.message ?? "Could not allocate a package number" }, { status: 500 })
  }
  const shortId = projectRow.short_id || project_id.replace(/-/g, "").slice(0, 4).toUpperCase()
  const packageNumber = `TTQ-${shortId}-${seq}`

  const { data: pkg, error: insErr } = await supabase
    .from("submittal_packages")
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

  const { error: itemErr } = await supabase
    .from("submittal_package_items")
    .insert(validIds.map(sid => ({ package_id: pkg.id, submittal_id: sid })))
  if (itemErr) {
    // Roll back the package so we don't leave an empty draft behind.
    await supabase.from("submittal_packages").delete().eq("id", pkg.id)
    return NextResponse.json({ error: itemErr.message }, { status: 500 })
  }

  return NextResponse.json({ package: { ...pkg, item_count: validIds.length } }, { status: 201 })
}
