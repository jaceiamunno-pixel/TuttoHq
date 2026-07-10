import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Per-user signature image. Used on the PCO cover sheet (Phase 3/4).
//
// Storage: company-assets at the DETERMINISTIC key {company_id}/signatures/
// {user_id}.png so a replace overwrites in place (no orphans) and the path is
// stable. The image is tiny, so it is sent straight to this route as multipart
// form-data — well under Vercel's 4.5 MB body limit, no presigned URL needed.
//
// The DB column user_profiles.signature_storage_path is written ONLY through the
// SECURITY DEFINER set_my_signature() RPC — the single sanctioned write path to
// user_profiles. No direct UPDATE policy exists (adding one would re-expose the
// role column to self-escalation), so this route must use the RPC.

const SIGNED_URL_TTL = 604800 // 7 days
const MAX_BYTES = 2 * 1024 * 1024
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])

async function signedUrlFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string | null | undefined,
): Promise<string | null> {
  if (!path) return null
  const { data } = await supabase.storage.from("company-assets").createSignedUrl(path, SIGNED_URL_TTL)
  return data?.signedUrl ?? null
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: profile } = await supabase
    .from("user_profiles").select("signature_storage_path").eq("user_id", user.id).maybeSingle()

  return NextResponse.json({ signature_url: await signedUrlFor(supabase, profile?.signature_storage_path) })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const form = await req.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 })
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Signature must be a PNG, JPG, or WebP image" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Signature image must be under 2 MB" }, { status: 400 })
  }

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  // Deterministic key — .png in the name is cosmetic; the object's content-type
  // is set from the real file type, so a JPG/WebP still renders correctly.
  const path = `${companyId}/signatures/${user.id}.png`
  const bytes = new Uint8Array(await file.arrayBuffer())

  const { error: uploadError } = await supabase.storage
    .from("company-assets")
    .upload(path, bytes, { contentType: file.type, upsert: true })
  if (uploadError) {
    console.error("Signature upload failed:", uploadError)
    return NextResponse.json({ error: "Could not store signature" }, { status: 500 })
  }

  // Write the path via the SECURITY DEFINER RPC (own-row, scoped to auth.uid()).
  const { error: rpcError } = await supabase.rpc("set_my_signature", { p_path: path })
  if (rpcError) {
    console.error("set_my_signature failed:", rpcError)
    return NextResponse.json({ error: "Could not save signature" }, { status: 500 })
  }

  return NextResponse.json({ signature_url: await signedUrlFor(supabase, path) })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: profile } = await supabase
    .from("user_profiles").select("signature_storage_path").eq("user_id", user.id).maybeSingle()

  if (profile?.signature_storage_path) {
    await supabase.storage.from("company-assets").remove([profile.signature_storage_path])
  }
  const { error } = await supabase.rpc("set_my_signature", { p_path: null })
  if (error) {
    console.error("Clearing signature failed:", error)
    return NextResponse.json({ error: "Could not remove signature" }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
