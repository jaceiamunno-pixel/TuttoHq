import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, C } from "@/lib/pdf-builder"
import { rgb } from "pdf-lib"

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
  const totalComplete  = manualComplete
  const pct            = totalItems > 0 ? Math.round((totalComplete / totalItems) * 100) : 0

  const b = await PDFBuilder.create(`Closeout Package — ${project.name}`, logoBytes)

  // Project info
  b.sectionHeader("PROJECT INFORMATION")
  b.twoCol("PROJECT NAME", project.name ?? "—", 3, "PROJECT NUMBER", project.number ?? "—", 1)
  b.twoCol("LOCATION", project.location ?? "—", 2, "DATE PREPARED", new Date().toLocaleDateString("en-US"), 1)
  b.twoCol("GENERAL CONTRACTOR", project.gc_name ?? "—", 1, "ARCHITECT / ENGINEER", project.architect ?? "—", 1)
  b.gap(8)

  // Overall progress
  b.sectionHeader("CLOSEOUT PROGRESS SUMMARY")
  b.twoCol("MANUAL CHECKLIST", `${manualComplete} of ${manualTotal} complete`, 1, "OVERALL COMPLETION", `${pct}%`, 1)
  b.twoCol("PENDING SUBMITTALS", String(pendingSubs), 1, "OPEN RFIs", String(openRFIs), 1)
  b.twoCol("UNSIGNED CHANGE ORDERS", String(unsignedCOs), 1, "OPEN PUNCH ITEMS", String(pendingPunch), 1)
  b.oneCol("MISSING AS-BUILT DRAWINGS", String(missingAsBuilt))
  b.gap(8)

  // Manual checklist by category
  const CATS: { key: string; label: string }[] = [
    { key: "documents",   label: "DOCUMENTS"   },
    { key: "inspections", label: "INSPECTIONS" },
    { key: "financial",   label: "FINANCIAL"   },
    { key: "training",    label: "TRAINING"    },
    { key: "handover",    label: "HANDOVER"    },
  ]

  for (const cat of CATS) {
    const catItems = items.filter(i => i.category === cat.key)
    if (catItems.length === 0) continue
    b.gap(4)
    b.sectionHeader(cat.label)
    for (const item of catItems) {
      const statusLabel = item.status === "complete" ? "Approved" : item.status === "in_progress" ? "Pending" : "Open"
      b.twoColStatus("ITEM", item.title, 4, "STATUS", statusLabel, 1)
      if (item.assigned_to || item.due_date) {
        b.twoCol("ASSIGNED TO", item.assigned_to ?? "—", 1, "DUE DATE", item.due_date ?? "—", 1)
      }
      if (item.file_name) b.oneCol("DOCUMENT ON FILE", item.file_name)
      if (item.notes)     b.oneCol("NOTES", item.notes)
    }
  }

  // Submittals
  if (subs.length > 0) {
    b.gap(6)
    b.sectionHeader("SUBMITTALS")
    b.tableHeader(["SUBMITTAL", "CSI SECTION", "REVIEW STATUS"], [320, 120, 112])
    for (const s of subs) {
      const status = s.review_status ?? "Pending"
      b.tableRow([s.file_name ?? "—", s.csi_section ?? "—", status], [320, 120, 112],
        status === "Approved")
    }
  }

  // RFIs
  if (rfis.length > 0) {
    b.gap(6)
    b.sectionHeader("RFIs")
    b.tableHeader(["RFI #", "SUBJECT", "STATUS"], [80, 360, 112])
    for (const r of rfis) {
      b.tableRow([r.rfi_number, r.subject, r.status], [80, 360, 112], r.status === "Closed")
    }
  }

  // Change Orders
  if (cos.length > 0) {
    b.gap(6)
    b.sectionHeader("CHANGE ORDERS")
    b.tableHeader(["CO #", "DESCRIPTION", "AMOUNT", "STATUS"], [60, 280, 100, 112])
    for (const c of cos) {
      const amt = c.pricing_sum != null ? `$${Number(c.pricing_sum).toLocaleString()}` : "—"
      b.tableRow([c.co_number, c.proposal ?? "—", amt, c.status], [60, 280, 100, 112],
        c.status === "Approved")
    }
  }

  // Drawings
  if (drawings.length > 0) {
    b.gap(6)
    b.sectionHeader("DRAWING LOG — CURRENT REVISIONS")
    b.tableHeader(["SHEET #", "TITLE", "DISCIPLINE", "REV", "STATUS"], [80, 230, 100, 50, 92])
    for (const d of drawings) {
      b.tableRow([d.drawing_number, d.sheet_title, d.discipline ?? "—", d.revision, d.status],
        [80, 230, 100, 50, 92], d.status === "As-Built")
    }
  }

  // Punch list
  if (punch.length > 0) {
    b.gap(6)
    b.sectionHeader("PUNCH LIST")
    b.tableHeader(["ITEM #", "DESCRIPTION", "LOCATION", "STATUS"], [60, 270, 120, 102])
    for (const p of punch) {
      b.tableRow([p.item_number, p.description, p.location ?? "—", p.status],
        [60, 270, 120, 102], p.status === "Completed")
    }
  }

  b.gap(16)
  b.signatureLines("Owner / Owner's Representative", "General Contractor")

  const pdfBytes = await b.save()
  const buf = Buffer.from(pdfBytes)

  const path = `closeout/${project_id}/closeout-package-${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(path, buf, { contentType: "application/pdf", upsert: true })

  const { data: urlData } = await supabase.storage
    .from("submittals")
    .createSignedUrl(path, 7 * 24 * 60 * 60)

  return NextResponse.json({ url: urlData?.signedUrl })
}
