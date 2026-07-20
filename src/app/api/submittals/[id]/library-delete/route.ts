import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { libraryDeleteOne } from "@/lib/library-delete-core"

// POST /api/submittals/[id]/library-delete — { action: "clear" | "delete" }
//
// Destroys content on a submittals row — the SAME row the project Submittal
// Log reads. Takes an EXPLICIT action in the JSON body; it is never inferred
// from row shape, because both actions are legal on a spec row (product
// decision, Jace 2026-07-17: spec rows are now deletable — the parser
// over-extracts and junk rows must be removable with a click; the old
// "spec rows can never be deleted" gate is reversed):
//
//   { action: "clear" } → DETACH (spec rows only). Remove the attachment
//     rows + their storage objects, clear the parent's file-derived fields
//     back to the parser's placeholder defaults, and KEEP the row. The
//     Submittal Log entry survives intact (section, title, type, seq,
//     project, spec_section_id untouched) — it simply shows "no file
//     attached", ready for re-import. 400 on manual/gmail rows: they carry
//     no spec placeholder worth keeping — delete instead.
//
//   { action: "delete" } → any row kind. Soft-delete it (status='deleted',
//     NEVER hard-deleted) AND remove its attachment rows + storage objects.
//     The row keeps section_seq/submittal_seq, so its CM number is retired,
//     never reused (0039 partial index + maxSectionSeq count soft-deleted
//     rows) and the surviving rows' numbers never shift. A deleted spec row
//     CAN come back: spec re-parse links by spec_number TEXT, not row
//     identity — if the parser still produces the requirement, it recreates
//     the row.
//
// Tenant-scoped: auth + explicit company match (403) + RLS on every
// statement. spec_section_id IS NOT NULL ⟺ source = 'spec_ingestion'.
//
// The delete/detach itself lives in src/lib/library-delete-core.ts
// (libraryDeleteOne) — shared with the bulk selection route
// (/api/submittals/bulk-library-delete) so both run identical per-row logic,
// including the orphan-checked, best-effort storage cleanup.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Explicit action, required. No default and no inference from row shape —
  // a spec row supports BOTH actions, so only the caller knows which the
  // user confirmed. (Pre-action clients get a 400, not a guessed mutation.)
  const body = await req.json().catch(() => null)
  const action = body?.action as unknown
  if (action !== "clear" && action !== "delete") {
    return NextResponse.json(
      { error: 'action is required: "clear" (remove the file, keep the row) or "delete" (soft-delete the row)' },
      { status: 400 },
    )
  }

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  // Load the row; the core validates the action against it server-side.
  const { data: row, error: selErr } = await supabase
    .from("submittals")
    .select("id, company_id, source, spec_section_id, storage_path, status")
    .eq("id", id)
    .single()
  if (selErr || !row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.company_id !== companyId) return NextResponse.json({ error: "Not in your company" }, { status: 403 })
  if (row.status === "deleted") return NextResponse.json({ error: "Already deleted" }, { status: 400 })

  const result = await libraryDeleteOne(supabase, row, action)
  if (!result.ok) {
    if (result.error === "clear_not_valid_on_manual_row") {
      return NextResponse.json(
        { error: "Only spec-book rows have a placeholder to keep — delete this row instead." },
        { status: 400 },
      )
    }
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    // Legacy naming kept: "detach" = the clear action, "delete" = soft-delete.
    mode: result.mode,
    storage_removed: result.storage_removed,
    storage_kept: result.storage_kept,
  })
}
