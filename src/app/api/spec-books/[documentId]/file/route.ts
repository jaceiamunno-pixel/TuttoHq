import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const SEVEN_DAYS = 60 * 60 * 24 * 7

// GET /api/spec-books/[documentId]/file — 7-day signed URL for the source PDF.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { documentId } = await params

  const { data: doc, error } = await supabase
    .from("project_documents")
    .select("file_path, file_name")
    .eq("id", documentId)
    .single()
  if (error || !doc?.file_path) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: signed, error: signError } = await supabase.storage
    .from("submittals")
    .createSignedUrl(doc.file_path, SEVEN_DAYS)
  if (signError || !signed) {
    return NextResponse.json({ error: signError?.message ?? "Failed to sign URL" }, { status: 500 })
  }

  return NextResponse.json({ url: signed.signedUrl, file_name: doc.file_name })
}
