import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildPcoDocuments } from "@/lib/pco-pdf"
import { payloadToDocData, type ImportPcoPayload } from "@/lib/pco-import/payload"

export const maxDuration = 60

// POST /api/change-orders/pco/preview-pdf?doc=cover|backup
//
// Renders the to-be-stored Tutto cover/backup PDF from a REVIEWED extracted
// object, with NO database row and NO storage write — the review UI shows the
// user exactly what will be committed before they commit. The uploaded .xlsx is
// never involved here (the browser parsed it; this takes the extracted data).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const which = req.nextUrl.searchParams.get("doc") === "backup" ? "backup" : "cover"
  const body = (await req.json().catch(() => null)) as ImportPcoPayload | null
  if (!body || typeof body.project_id !== "string") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  // Project context (RLS scopes to the caller's company).
  const { data: project } = await supabase.from("projects")
    .select("name, number, location, gc_name").eq("id", body.project_id).maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

  // Company letterhead context.
  const { data: settings } = await supabase.from("company_settings")
    .select("logo_path, phone, address_line1, address_line2, logo_scale_pct").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  let companyName: string | null = project.gc_name ?? null
  if (companyId) {
    const { data: companyRow } = await supabase.from("companies").select("name").eq("id", companyId).maybeSingle()
    companyName = companyRow?.name ?? companyName
  }

  const docData = payloadToDocData(body, { name: project.name, number: project.number, location: project.location })
  // Imported PCOs carry no TuttoHQ signer signature asset (historical signer).
  const { cover, backup } = await buildPcoDocuments(docData, {
    logoBytes, sigBytes: null, companyName,
    phone: settings?.phone ?? null,
    addressLine1: settings?.address_line1 ?? null,
    addressLine2: settings?.address_line2 ?? null,
    logoScalePct: settings?.logo_scale_pct ?? undefined,
  })

  const bytes = which === "backup" ? backup : cover
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="pco-${which}-preview.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}
