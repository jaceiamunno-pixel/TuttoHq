import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"

// Buckets a signed upload URL may be minted for. Anything else is rejected so a
// crafted request can't obtain write URLs into unrelated storage.
const ALLOWED_BUCKETS = new Set(["submittals", "photos", "company-assets"])

// POST /api/storage/presigned-url — issues a Supabase Storage signed upload URL
// so the browser can PUT a file straight to storage, bypassing Vercel's 4.5 MB
// serverless function body limit. The caller then sends the returned `path`
// (not the file bytes) to the feature's own POST route.
//
// Shared by every upload flow except spec books, which keeps its own
// presigned-url route because it must embed a DB row id in the storage path.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const bucket:   string = typeof body?.bucket    === "string" ? body.bucket.trim()    : ""
  const prefix:   string = typeof body?.prefix    === "string" ? body.prefix.trim()    : ""
  const fileName: string = typeof body?.file_name === "string" ? body.file_name.trim() : ""
  const clientId: string = typeof body?.client_id === "string" ? body.client_id.trim() : ""

  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Unsupported storage bucket" }, { status: 400 })
  }
  if (!fileName) {
    return NextResponse.json({ error: "file_name is required" }, { status: 400 })
  }

  // Sanitize the prefix into clean path segments — no traversal, no stray slashes.
  const safePrefix = prefix
    .split("/")
    .map(seg => seg.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .filter(seg => seg && seg !== "." && seg !== "..")
    .join("/")
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")

  // Tenant-isolated path: {company_id}/... prefix is what the new storage.objects
  // RLS policies will check via (storage.foldername(name))[1].
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }

  // If the caller supplied a UUID-shaped client_id, reuse it as the path's
  // unique segment so retries write to the same object key (upsert:true makes
  // the PUT itself idempotent). Used by the offline photo sync runner so a
  // partial failure can re-PUT without producing storage orphans. Anything
  // not UUID-shaped is ignored — falls back to a fresh randomUUID.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const idSegment = UUID_RE.test(clientId) ? clientId : randomUUID()
  const path = safePrefix
    ? `${companyId}/${safePrefix}/${idSegment}_${safeName}`
    : `${companyId}/${idSegment}_${safeName}`

  const { data: signed, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(path, { upsert: true })
  if (error || !signed) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create an upload URL" },
      { status: 500 },
    )
  }

  return NextResponse.json({ path, signed_url: signed.signedUrl }, { status: 201 })
}
