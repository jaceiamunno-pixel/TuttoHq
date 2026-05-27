import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, type FieldCell } from "@/lib/pdf-builder"

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { project_id } = await req.json()
  if (!project_id) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  const [projectRes, itemsRes, punchRes, submittalsRes, rfisRes, cosRes, drawingsRes, settingsRes] = await Promise.all([
    supabase.from("projects").select("*").eq("id", project_id).single(),
    supabase.from("closeout_items").select("*").eq("project_id", project_id).order("sort_order"),
    supabase.from("punch_items").select("*").eq("project_id", project_id).order("item_number"),
    supabase.from("submittals").select("*").eq("project_id", project_id).eq("status", "active").order("created_at"),
    supabase.from("rfis").select("*").eq("project_id", project_id).order("rfi_number"),
    supabase.from("change_orders").select("*").eq("project_id", project_id).order("co_number"),
    supabase.from("drawing_log").select("*").eq("project_id", project_id).eq("is_current", true).order("drawing_number"),
    supabase.from("company_settings").select("*").maybeSingle(),
  ])

  const project = projectRes.data
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  let logoBytes: ArrayBuffer | null = null
  if (settingsRes.data?.logo_path) {
    const { data } = await supabase.storage.from("company-assets").download(settingsRes.data.logo_path)
    if (data) logoBytes = await data.arrayBuffer()
  }

  const items    = itemsRes.data    ?? []
  const punch    = punchRes.data    ?? []
  const subs     = submittalsRes.data ?? []
  const rfis     = rfisRes.data     ?? []
  const cos      = cosRes.data      ?? []
  const drawings = drawingsRes.data ?? []

  // Compute overall stats
  const manualTotal    = items.length
  const manualComplete = items.filter(i => i.status === "complete").length
  const pendingPunch   = punch.filter(p => p.status !== "Completed").length
  const pendingSubs    = subs.filter(s => s.review_status !== "Approved").length
  const openRFIs       = rfis.filter(r => r.status !== "Closed").length
  const unsignedCOs    = cos.filter(c => c.status !== "Approved" && c.status !== "Void").length
  const missingAsBuilt = drawings.filter(d => d.status !== "As-Built").length
  const dynamicTotal   = pendingPunch + pendingSubs + openRFIs + unsignedCOs + missingAsBuilt
  const totalItems     = manualTotal + dynamicTotal
  const pct            = totalItems > 0 ? Math.round((manualComplete / totalItems) * 100) : 0

  const pdf = await PDFBuilder.create({
    documentType: "Closeout Package",
    documentNumber: project.name,
    logoBytes,
  })

  // Project info
  pdf.projectBlock({
    name: project.name, number: project.number, location: project.location,
    gc_name: project.gc_name, architect: project.architect,
  })

  // Progress summary
  pdf.sectionDivider("Closeout Progress Summary")
  pdf.fieldGrid([
    [{ label: "Manual Checklist", value: `${manualComplete} of ${manualTotal} complete` },
     { label: "Overall Completion", value: `${pct}%` }],
    [{ label: "Pending Submittals", value: String(pendingSubs) },
     { label: "Open RFIs", value: String(openRFIs) }],
    [{ label: "Unsigned Change Orders", value: String(unsignedCOs) },
     { label: "Open Punch Items", value: String(pendingPunch) }],
    [{ label: "Missing As-Built Drawings", value: String(missingAsBuilt) }],
  ])

  // Manual checklist by category
  const CATS: { key: string; label: string }[] = [
    { key: "documents",   label: "Documents"   },
    { key: "inspections", label: "Inspections" },
    { key: "financial",   label: "Financial"   },
    { key: "training",    label: "Training"    },
    { key: "handover",    label: "Handover"    },
  ]

  for (const cat of CATS) {
    const catItems = items.filter(i => i.category === cat.key)
    if (catItems.length === 0) continue
    pdf.sectionDivider(cat.label)
    for (const item of catItems) {
      const statusLabel = item.status === "complete" ? "Approved" : item.status === "in_progress" ? "Pending" : "Open"
      const rows: FieldCell[][] = [
        [{ label: "Item", value: item.title }, { label: "Status", status: statusLabel }],
      ]
      if (item.assigned_to || item.due_date) {
        rows.push([{ label: "Assigned To", value: item.assigned_to }, { label: "Due Date", value: item.due_date }])
      }
      if (item.file_name) rows.push([{ label: "Document on File", value: item.file_name }])
      if (item.notes)     rows.push([{ label: "Notes", value: item.notes }])
      pdf.fieldGrid(rows)
    }
  }

  // Submittals
  if (subs.length > 0) {
    pdf.sectionDivider("Submittals")
    pdf.table(
      ["Submittal", "CSI Section", "Review Status"],
      subs.map(s => [s.file_name ?? "—", s.csi_section ?? "—", s.review_status ?? "Pending"]),
      [310, 116, 100],
      r => r[2] === "Approved",
    )
  }

  // RFIs
  if (rfis.length > 0) {
    pdf.sectionDivider("RFIs")
    pdf.table(
      ["RFI #", "Subject", "Status"],
      rfis.map(r => [r.rfi_number ?? "—", r.subject ?? "—", r.status ?? "—"]),
      [76, 340, 110],
      r => r[2] === "Closed",
    )
  }

  // Change Orders
  if (cos.length > 0) {
    pdf.sectionDivider("Change Orders")
    pdf.table(
      ["CO #", "Description", "Amount", "Status"],
      cos.map(c => [
        c.co_number ?? "—",
        c.proposal ?? "—",
        c.pricing_sum != null ? `$${Number(c.pricing_sum).toLocaleString()}` : "—",
        c.status ?? "—",
      ]),
      [58, 268, 96, 104],
      r => r[3] === "Approved",
    )
  }

  // Drawings
  if (drawings.length > 0) {
    pdf.sectionDivider("Drawing Log — Current Revisions")
    pdf.table(
      ["Sheet #", "Title", "Discipline", "Rev", "Status"],
      drawings.map(d => [
        d.drawing_number ?? "—", d.sheet_title ?? "—", d.discipline ?? "—",
        d.revision ?? "—", d.status ?? "—",
      ]),
      [76, 220, 94, 46, 90],
      r => r[4] === "As-Built",
    )
  }

  // Punch list
  if (punch.length > 0) {
    pdf.sectionDivider("Punch List")
    pdf.table(
      ["Item #", "Description", "Location", "Status"],
      punch.map(p => [p.item_number ?? "—", p.description ?? "—", p.location ?? "—", p.status ?? "—"]),
      [58, 258, 114, 96],
      r => r[3] === "Completed",
    )
  }

  pdf.signatureBlock("Owner / Owner's Representative", "General Contractor")

  const pdfBytes = await pdf.save()
  const buf = Buffer.from(pdfBytes)

  const path = `closeout/${project_id}/closeout-package-${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(path, buf, { contentType: "application/pdf", upsert: true })

  const { data: urlData } = await supabase.storage
    .from("submittals")
    .createSignedUrl(path, 7 * 24 * 60 * 60)

  return NextResponse.json({ url: urlData?.signedUrl })
}
