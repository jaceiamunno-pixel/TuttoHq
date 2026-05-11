import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/search?q=concrete
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim()
  if (!q) {
    return NextResponse.json({ files: [] })
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("submittals")
    .select("id, file_name, storage_path, mime_type, file_size, created_at, csi_division, division_name, csi_section, section_name")
    .eq("status", "active")
    .textSearch("search_vector", q, { type: "websearch" })
    .order("created_at", { ascending: false })
    .limit(50)

  if (error) {
    console.error("Search failed:", error)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }

  const rows = data ?? []

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
    id:            r.id,
    file_name:     r.file_name,
    file_url:      r.storage_path ? (signedUrls[r.storage_path] ?? "") : "",
    mime_type:     r.mime_type,
    file_size:     r.file_size,
    created_at:    r.created_at,
    csi_division:  r.csi_division,
    division_name: r.division_name,
    csi_section:   r.csi_section,
    section_name:  r.section_name,
  }))

  return NextResponse.json({ files })
}
