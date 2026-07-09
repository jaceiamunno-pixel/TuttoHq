import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/submittal-packages/[id]/pdf — return a fresh signed URL for the
// package's stored transmittal PDF. The PDF is composed ONCE at create and
// stored at pdf_file_path; this route does NOT recompose (the mode/recipient/
// date used to build it aren't persisted). Used by "Preview PDF" / download.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Existence check doubles as the ownership check — RLS hides packages
  // outside the caller's company, so a null here is "not yours" or "not real".
  const { data: pkg } = await supabase
    .from("submittal_packages")
    .select("pdf_file_path")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })
  if (!pkg.pdf_file_path) {
    return NextResponse.json({ error: "This package has no generated PDF" }, { status: 404 })
  }

  const { data: signed } = await supabase.storage
    .from("submittals")
    .createSignedUrl(pkg.pdf_file_path, 60 * 60)

  return NextResponse.json({ url: signed?.signedUrl ?? null, path: pkg.pdf_file_path })
}
