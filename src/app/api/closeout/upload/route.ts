import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const formData = await req.formData()
  const file     = formData.get("file") as File | null
  const itemId   = formData.get("item_id") as string | null

  if (!file || !itemId) return NextResponse.json({ error: "file and item_id required" }, { status: 400 })

  const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
  const storagePath = `closeout/${itemId}/${Date.now()}_${safeName}`

  const bytes = await file.arrayBuffer()
  const { error: storageError } = await supabase.storage
    .from("submittals")
    .upload(storagePath, bytes, { contentType: file.type || "application/octet-stream", upsert: true })

  if (storageError) return NextResponse.json({ error: "Upload failed" }, { status: 500 })

  const { data: urlData } = await supabase.storage
    .from("submittals")
    .createSignedUrl(storagePath, 7 * 24 * 60 * 60)

  return NextResponse.json({ file_url: storagePath, file_name: file.name, signed_url: urlData?.signedUrl })
}
