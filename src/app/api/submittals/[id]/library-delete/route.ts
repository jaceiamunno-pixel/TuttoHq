import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { libraryDeleteOne } from "@/lib/library-delete-core"

// POST /api/submittals/[id]/library-delete
//
// Deletes a Library entry. A Library entry is a submittals row WITH a file
// attached — the SAME row the project Submittal Log reads. So "delete" must
// branch on whether the row carries spec-book log identity:
//
//   spec_ingestion (spec_section_id NOT NULL) → DETACH. Remove the
//     attachment rows + their storage objects, clear the parent's
//     file-derived fields back to the parser's placeholder defaults, and
//     KEEP the row. The Submittal Log entry survives intact (section,
//     title, type, seq, project, spec_section_id untouched) — it simply
//     shows "no file attached", ready for re-import. NEVER delete a
//     spec-built log row.
//
//   manual / gmail (spec_section_id NULL) → DELETE. The row exists only as
//     a Library item, so soft-delete it (status='deleted', matching the
//     existing DELETE /api/submittals/[id] pattern) AND remove its
//     attachment rows + storage objects.
//
// The branch is decided SERVER-SIDE from the DB row — never trusted from
// the client. spec_section_id IS NOT NULL ⟺ source = 'spec_ingestion'
// (verified: 726/726 spec rows linked, 0 manual/gmail rows linked).
//
// Tenant-scoped: auth + explicit company match + RLS on every statement.
//
// The delete/detach itself lives in src/lib/library-delete-core.ts
// (libraryDeleteOne) — moved there VERBATIM so the bulk selection route
// (/api/submittals/bulk-library-delete) runs the exact same per-row logic.
// This route's behavior is unchanged.

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  // Load the row + decide the branch server-side.
  const { data: row, error: selErr } = await supabase
    .from("submittals")
    .select("id, company_id, source, spec_section_id, storage_path, status")
    .eq("id", id)
    .single()
  if (selErr || !row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.company_id !== companyId) return NextResponse.json({ error: "Not in your company" }, { status: 403 })
  if (row.status === "deleted") return NextResponse.json({ error: "Already deleted" }, { status: 400 })

  const result = await libraryDeleteOne(supabase, row)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({
    ok: true,
    mode: result.mode === "detach" ? "detach" : "delete",
    storage_removed: result.storage_removed,
    storage_kept: result.storage_kept,
  })
}
