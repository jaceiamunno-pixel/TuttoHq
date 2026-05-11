import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path, cover_page_path")
    .eq("id", 1)
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

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const formData = await req.formData()

  const type = formData.get("type") as "logo" | "cover_page" | null
  const file = formData.get("file") as File | null

  if (!type || !file) {
    return NextResponse.json({ error: "Missing type or file" }, { status: 400 })
  }

  const ext  = file.name.split(".").pop() ?? "bin"
  const path = type === "logo" ? `logo.${ext}` : "cover.pdf"

  const { error: uploadError } = await supabase.storage
    .from("company-assets")
    .upload(path, file, { upsert: true, contentType: file.type })

  if (uploadError) {
    console.error("Asset upload failed:", uploadError)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }

  const updateData = type === "logo" ? { logo_path: path } : { cover_page_path: path }

  await supabase
    .from("company_settings")
    .upsert({ id: 1, ...updateData, updated_at: new Date().toISOString() })

  if (type === "logo") {
    const { data: urlData } = await supabase.storage
      .from("company-assets")
      .createSignedUrl(path, 604800)
    return NextResponse.json({ logo_url: urlData?.signedUrl ?? null })
  }

  return NextResponse.json({ success: true })
}
