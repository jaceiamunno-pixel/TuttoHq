import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { composeCloseoutPackagePdf } from "@/lib/closeout-package-pdf"

// POST /api/closeout-packages/[id]/pdf — (re)generate the package PDF and
// return a signed URL. Used by the preview-before-dispatch modal.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: pkg } = await supabase
    .from("closeout_packages")
    .select("id")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })

  let storagePath: string
  try {
    ({ storagePath } = await composeCloseoutPackagePdf(supabase, id))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate package PDF" },
      { status: 500 },
    )
  }

  await supabase.from("closeout_packages").update({ pdf_file_path: storagePath }).eq("id", id)

  const { data: signed } = await supabase.storage
    .from("submittals")
    .createSignedUrl(storagePath, 60 * 60)

  return NextResponse.json({ url: signed?.signedUrl ?? null, path: storagePath })
}
