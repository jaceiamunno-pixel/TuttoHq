import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const entity_type = searchParams.get("entity_type")
  const entity_id = searchParams.get("entity_id")
  if (!entity_type || !entity_id) return NextResponse.json({ error: "Missing params" }, { status: 400 })

  const { data: photos } = await supabase
    .from("item_photos")
    .select("id, storage_path, file_name")
    .eq("entity_type", entity_type)
    .eq("entity_id", entity_id)
    .order("created_at")

  if (!photos?.length) return NextResponse.json([])

  const withUrls = await Promise.all(
    photos.map(async (p) => {
      const { data } = await supabase.storage.from("photos").createSignedUrl(p.storage_path, 3600)
      return { id: p.id, url: data?.signedUrl ?? "", file_name: p.file_name }
    })
  )
  return NextResponse.json(withUrls)
}

// The photo was already PUT straight to the `photos` bucket from the browser
// via a signed upload URL, so this route receives only JSON metadata.
//
// Accepts an optional `client_id` (UUID) that becomes the inserted row's id.
// This makes the route idempotent: the offline sync runner can retry after a
// partial failure and the second call will return the existing row instead of
// creating a duplicate. Falls back to a DB-generated id when client_id is
// absent (existing inline-upload callers).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const entity_type = typeof body?.entity_type === "string" ? body.entity_type : ""
  const entity_id   = typeof body?.entity_id   === "string" ? body.entity_id   : ""
  const file_path   = typeof body?.file_path   === "string" ? body.file_path.trim() : ""
  const file_name   = typeof body?.file_name   === "string" ? body.file_name : ""
  const client_id   = typeof body?.client_id   === "string" ? body.client_id.trim() : ""
  if (!entity_type || !entity_id || !file_path) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 })
  }

  const { data: profile } = await supabase.from("user_profiles").select("company_id").maybeSingle()
  const company_id = profile?.company_id ?? null

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const useClientId = UUID_RE.test(client_id)

  const insertData: Record<string, unknown> = {
    entity_type,
    entity_id,
    storage_path: file_path,
    file_name,
    company_id,
    uploaded_by: user.id,
  }
  if (useClientId) insertData.id = client_id

  // Upsert on the row id when client_id is supplied so a retry returns the
  // existing row (treated as a no-op). The update path overwrites only the
  // columns we pass — entity_type/entity_id/etc are stable per photo, so an
  // accidental duplicate insert from a different caller cannot reach this
  // path (the route requires auth and scopes by company_id implicitly via
  // user_profiles).
  const builder = useClientId
    ? supabase.from("item_photos").upsert(insertData, { onConflict: "id" })
    : supabase.from("item_photos").insert(insertData)
  const { data: photo, error: insertError } = await builder.select().single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  const { data: urlData } = await supabase.storage.from("photos").createSignedUrl(file_path, 3600)
  return NextResponse.json({ id: photo?.id, url: urlData?.signedUrl ?? "", file_name })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get("id")
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 })

  const { data: photo } = await supabase.from("item_photos").select("storage_path").eq("id", id).maybeSingle()
  if (photo?.storage_path) {
    await supabase.storage.from("photos").remove([photo.storage_path])
  }
  await supabase.from("item_photos").delete().eq("id", id)
  return NextResponse.json({ success: true })
}
