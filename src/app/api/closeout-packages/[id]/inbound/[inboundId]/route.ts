import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// ─── Closeout package inbound — place / dismiss (Session K1) ────────────────
// POST   /api/closeout-packages/[id]/inbound/[inboundId]  — body { closeout_item_id }.
//          Copies the inbound file onto the chosen closeout_item, marks the
//          item complete, marks the inbound row 'placed'. The closeout_items
//          status-change trigger advances the package's status.
// DELETE /api/closeout-packages/[id]/inbound/[inboundId]  — dismiss the orphan.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; inboundId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, inboundId } = await params
  const body = await req.json().catch(() => ({}))
  const closeoutItemId = (body as { closeout_item_id?: string }).closeout_item_id
  if (!closeoutItemId) {
    return NextResponse.json({ error: "closeout_item_id is required" }, { status: 400 })
  }

  // The inbound row must belong to this package and still be pending.
  const { data: inbound } = await supabase
    .from("closeout_package_inbound")
    .select("id, package_id, file_name, storage_path, status")
    .eq("id", inboundId)
    .eq("package_id", id)
    .maybeSingle()
  if (!inbound) return NextResponse.json({ error: "Inbound reply not found" }, { status: 404 })
  if (inbound.status !== "pending") {
    return NextResponse.json({ error: "This reply has already been placed or dismissed" }, { status: 409 })
  }

  // The target item must be part of this package (junction row exists).
  const { data: junction } = await supabase
    .from("closeout_package_items")
    .select("closeout_item_id")
    .eq("package_id", id)
    .eq("closeout_item_id", closeoutItemId)
    .maybeSingle()
  if (!junction) {
    return NextResponse.json({ error: "That item is not part of this package" }, { status: 400 })
  }

  // Copy the inbound file metadata onto the closeout_item and mark complete.
  const { error: itemErr } = await supabase
    .from("closeout_items")
    .update({
      file_url: inbound.storage_path,
      file_name: inbound.file_name,
      status: "complete",
      completed_at: new Date().toISOString(),
      completed_by: user.id,
    })
    .eq("id", closeoutItemId)
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 })

  await supabase
    .from("closeout_package_inbound")
    .update({
      status: "placed",
      placed_closeout_item_id: closeoutItemId,
      placed_at: new Date().toISOString(),
    })
    .eq("id", inboundId)

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; inboundId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id, inboundId } = await params

  const { error } = await supabase
    .from("closeout_package_inbound")
    .update({ status: "dismissed" })
    .eq("id", inboundId)
    .eq("package_id", id)
    .eq("status", "pending")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
