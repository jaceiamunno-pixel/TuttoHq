import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path, cover_page_path")
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
  })
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
