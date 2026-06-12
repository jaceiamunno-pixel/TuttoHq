import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  // select("*") (not an explicit column list) so this stays resilient if the
  // display_name column has not been migrated yet (0006) — a missing column is
  // simply absent rather than erroring the whole read and breaking the logo.
  const { data: settings } = await supabase
    .from("company_settings")
    .select("*")
    .maybeSingle()

  let logo_url: string | null = null
  if (settings?.logo_path) {
    const { data: urlData } = await supabase.storage
      .from("company-assets")
      .createSignedUrl(settings.logo_path, 604800)
    logo_url = urlData?.signedUrl ?? null
  }

  return NextResponse.json({
    logo_url,
    has_cover_page: !!settings?.cover_page_path,
    display_name: settings?.display_name ?? null,
    address_line1: settings?.address_line1 ?? null,
    address_line2: settings?.address_line2 ?? null,
    phone: settings?.phone ?? null,
    default_oh_p_percent: settings?.default_oh_p_percent ?? null,
  })
}

// PATCH /api/settings — company cover-header fields (address/phone) and the
// default OH&P percent used to prefill the PCO builder. Admin-only, matching
// the logo/cover POST gate above (company-wide identity + pricing config).
// default_oh_p_percent is stored as a fraction (0.15 == 15%); validated 0..1.
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const updates: Record<string, string | number | null> = {}

  for (const key of ["display_name", "address_line1", "address_line2", "phone"] as const) {
    if (body[key] === undefined) continue
    updates[key] = typeof body[key] === "string" && body[key].trim() ? body[key].trim() : null
  }

  if (body.default_oh_p_percent !== undefined) {
    if (body.default_oh_p_percent === null || body.default_oh_p_percent === "") {
      updates.default_oh_p_percent = null
    } else {
      const n = Number(body.default_oh_p_percent)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return NextResponse.json({ error: "default_oh_p_percent must be a fraction between 0 and 1" }, { status: 400 })
      }
      updates.default_oh_p_percent = n
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }

  const { data: existing } = await supabase.from("company_settings").select("id").maybeSingle()
  if (existing) {
    const { error } = await supabase
      .from("company_settings")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
    if (error) return NextResponse.json({ error: "Failed to save company details" }, { status: 500 })
  } else {
    const { error } = await supabase.from("company_settings").insert(updates)
    if (error) return NextResponse.json({ error: "Failed to save company details" }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

// The logo / cover-page file was already PUT straight to the `company-assets`
// bucket from the browser via a signed upload URL, so this route receives only
// JSON metadata: `file_path` already points at the stored object.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const type     = body?.type === "logo" || body?.type === "cover_page" ? body.type : null
  const filePath = typeof body?.file_path === "string" ? body.file_path.trim() : ""

  if (!type || !filePath) {
    return NextResponse.json({ error: "Missing type or file_path" }, { status: 400 })
  }

  const updateData: Record<string, string> =
    type === "logo" ? { logo_path: filePath } : { cover_page_path: filePath }

  const { data: existing } = await supabase.from("company_settings").select("id").maybeSingle()
  if (existing) {
    await supabase.from("company_settings").update({ ...updateData, updated_at: new Date().toISOString() }).eq("id", existing.id)
  } else {
    await supabase.from("company_settings").insert(updateData)
  }

  if (type === "logo") {
    const { data: urlData } = await supabase.storage
      .from("company-assets")
      .createSignedUrl(filePath, 604800)
    return NextResponse.json({ logo_url: urlData?.signedUrl ?? null })
  }

  return NextResponse.json({ success: true })
}
