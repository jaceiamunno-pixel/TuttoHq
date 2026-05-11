import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/files?code=03+10+00
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")
  if (!code) {
    return NextResponse.json({ error: "code is required" }, { status: 400 })
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("submittals")
    .select("id, file_name, storage_path, mime_type, file_size, created_at")
    .eq("csi_section", code)
    .eq("status", "active")
    .order("file_name")

  if (error) {
    console.error("Failed to load files:", error)
    return NextResponse.json({ error: "Failed to load files" }, { status: 500 })
  }

  const rows = data ?? []

  // Batch-generate signed URLs (7-day expiry)
  const paths = rows.map(r => r.storage_path).filter(Boolean) as string[]
  const signedUrls: Record<string, string> = {}

  if (paths.length > 0) {
    const { data: urlData } = await supabase.storage
      .from("submittals")
      .createSignedUrls(paths, 604800)

    for (const u of urlData ?? []) {
      if (u.path && u.signedUrl) signedUrls[u.path] = u.signedUrl
    }
  }

  const files = rows.map(r => ({
    id:         r.id,
    file_name:  r.file_name,
    file_url:   r.storage_path ? (signedUrls[r.storage_path] ?? "") : "",
    mime_type:  r.mime_type,
    file_size:  r.file_size,
    created_at: r.created_at,
  }))

  return NextResponse.json({ files })
}
