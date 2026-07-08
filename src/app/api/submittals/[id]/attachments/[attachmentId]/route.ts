import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// DELETE /api/submittals/[id]/attachments/[attachmentId]
//
// Removes a SINGLE revision (submittal_attachments row) from a submittal log
// row, KEEPING the parent submittal. Destructive on attachments + storage +
// is_current re-promotion, so the delete runs through the SECURITY INVOKER RPC
// remove_submittal_attachment (migration 0035), which in one transaction:
//   - RLS-scopes the lookup + delete to the caller's company (no cross-tenant
//     delete — an invisible row raises "not found or not accessible")
//   - if the deleted attachment was CURRENT, promotes the next-newest so the
//     parent never ends up zero-current-with-stale-file
//   - if it was the LAST attachment, resets the parent to the empty
//     spec-ingestion placeholder (mirrors Library detach), KEEPING the row
//
// After the RPC, the freed storage object is removed ONLY when nothing else
// references it — orphan-checked against BOTH submittal_attachments and live
// submittals (a copy can be shared across rows). Mirrors library-delete's
// guard. Best-effort: a failed storage removal does not fail the request (the
// DB is already consistent; a leftover object is a reclaimable orphan). We
// NEVER remove an object still referenced by a live row.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { attachmentId } = await params
  if (!attachmentId) {
    return NextResponse.json({ error: "attachment id required" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Demo immutability gate. The demo tenant (role='demo') is already RLS-
  // blocked on delete, but we 403 here for parity with other destructive
  // routes and a clean message. Fail-open in try/catch — a failed
  // is_demo_user() lookup must never 403 a real user (RLS still holds).
  try {
    const { data: isDemo } = await supabase.rpc("is_demo_user")
    if (isDemo === true) {
      return NextResponse.json(
        { error: "This action isn't available on the demo account." },
        { status: 403 },
      )
    }
  } catch {
    // is_demo_user() lookup failed — treat as NOT demo and fall through.
  }

  // Single transactional RPC: RLS-scoped resolve + delete + re-promote (or
  // placeholder reset). Returns the freed storage path, the promoted
  // attachment id (if any), and whether the parent was reset to placeholder.
  const { data, error: rpcErr } = await supabase
    .rpc("remove_submittal_attachment", { p_attachment_id: attachmentId })
    .single()

  const result = data as {
    deleted_storage_path: string | null
    promoted_attachment_id: string | null
    row_reset: boolean
  } | null

  if (rpcErr || !result) {
    const msg = rpcErr?.message ?? "delete failed"
    // The RPC raises 'attachment not found or not accessible' when the row is
    // invisible to the caller (wrong company / already gone) → 404.
    const status = /not found|not accessible/i.test(msg) ? 404 : 500
    return NextResponse.json({ error: msg }, { status })
  }

  // Orphan-checked storage cleanup — best-effort. Remove the freed object only
  // when NO attachment row and NO live submittal still references the path.
  // (After promotion the parent points at the promoted file; after reset it is
  // null — so the parent never references the freed path here. Any remaining
  // reference means a copy shared across rows: keep the object.)
  const path = result.deleted_storage_path
  if (path) {
    const { count: attRefs } = await supabase
      .from("submittal_attachments")
      .select("id", { count: "exact", head: true })
      .eq("storage_path", path)
    const { count: subRefs } = await supabase
      .from("submittals")
      .select("id", { count: "exact", head: true })
      .eq("storage_path", path)
      .neq("status", "deleted")
    if ((attRefs ?? 0) === 0 && (subRefs ?? 0) === 0) {
      const { error: rmErr } = await supabase.storage.from("submittals").remove([path])
      if (rmErr) console.warn("[remove-attachment] storage remove failed", path, rmErr.message)
    } else {
      console.info("[remove-attachment] storage path still referenced, keeping", path)
    }
  }

  return NextResponse.json({
    ok: true,
    promoted_attachment_id: result.promoted_attachment_id,
    row_reset: result.row_reset,
  })
}
