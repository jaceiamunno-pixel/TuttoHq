import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { maxSectionSeq, isSectionSeqConflict } from "@/lib/section-seq"
import { REVIEW_STATUSES, isReviewStatus } from "@/lib/review-status"
import { SUBMITTAL_TYPES, isSubmittalType } from "@/lib/bulk-import-detect"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = [
    "review_status", "csi_division", "division_name", "csi_section", "section_name",
    "project_id", "transmittal_sent_at", "transmittal_recipient",
    // Submittal-log tracker columns
    "received_date", "sent_to_ae_date", "returned_from_ae_date", "returned_to_sub_date",
    // Unified vendor link (vendors master + vendor_people). RLS on those tables
    // governs which ids are valid; the FK + ON DELETE SET NULL handle integrity.
    "vendor_id", "vendor_person_id",
    // Inline title edit. file_name updates implicitly lock the row so the
    // normalizer / spec-book re-parse never overwrites a human's choice.
    "file_name",
    // Requirement satisfied by another submittal (migration 0043). Display-only
    // flag — never touches description/title.
    "fulfilled_by_other",
    // Inline type edit on the log. Nullable — null means "untyped".
    "submittal_type",
    // Inline lead-time edit on the log (migration 0048). Free text — vendors
    // quote "6-8 weeks", "12 wks ARO", etc., so no vocabulary to enforce.
    "lead_time",
  ]
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  // review_status is a closed vocabulary (mirrored by 0046's DB CHECK).
  // This route accepting free text is exactly how 'Pending' / 'Review'
  // drifted into prod — reject out-of-vocab values server-side.
  if ("review_status" in safe && !isReviewStatus(safe.review_status)) {
    return NextResponse.json(
      { error: `review_status must be one of: ${REVIEW_STATUSES.join(", ")}` },
      { status: 400 },
    )
  }

  // submittal_type is a closed vocabulary + null (column is nullable, no DB
  // CHECK — this route is the only guard). null clears the type; free text is
  // rejected so the column can't drift the way review_status once did.
  if ("submittal_type" in safe && safe.submittal_type !== null && !isSubmittalType(safe.submittal_type)) {
    return NextResponse.json(
      { error: `submittal_type must be null or one of: ${SUBMITTAL_TYPES.join(", ")}` },
      { status: 400 },
    )
  }

  // lead_time is free text, but only text — reject non-strings so a bad client
  // can't write objects/numbers. Trimmed; empty clears to null.
  if ("lead_time" in safe) {
    if (safe.lead_time !== null && typeof safe.lead_time !== "string") {
      return NextResponse.json({ error: "lead_time must be a string or null" }, { status: 400 })
    }
    const v = typeof safe.lead_time === "string" ? safe.lead_time.trim() : null
    safe.lead_time = v && v.length > 0 ? v : null
  }

  // fulfilled_by_other is a strict boolean — reject anything else so a bad
  // client can't write a truthy string / number into the column.
  if ("fulfilled_by_other" in safe && typeof safe.fulfilled_by_other !== "boolean") {
    return NextResponse.json({ error: "fulfilled_by_other must be a boolean" }, { status: 400 })
  }

  // Auto-flag when a user manually changes the CSI classification
  if ("csi_division" in safe || "csi_section" in safe) {
    safe.manually_overridden = true
    safe.overridden_by = user.id
  }

  // Inline title edits are sticky: server-side guarantee that title_locked is
  // set whenever file_name comes through this route. Trimmed; empty rejects.
  if ("file_name" in safe) {
    const v = typeof safe.file_name === "string" ? safe.file_name.trim() : ""
    if (v.length === 0) {
      return NextResponse.json({ error: "file_name cannot be empty" }, { status: 400 })
    }
    safe.file_name = v
    safe.title_locked = true
  }

  // A move to a different project, or a reclassification to a different section,
  // changes the (project_id, csi_section, section_seq) tuple the 0039 unique
  // index guards. Re-derive the placement-scoped numbers for the destination:
  //   • submittal_seq — per project; assigned on project attach/move (unchanged
  //     legacy behavior; Library uploads start with project_id = null).
  //   • section_seq — per (project, section); a numbered row that MOVES section
  //     or project must take a FRESH number in the destination, because its old
  //     number was scoped to the old section and could collide there under the
  //     unique index (a plain UPDATE would 23505). Unnumbered rows stay so.
  const changesProject = typeof safe.project_id === "string" && !!safe.project_id
  const changesSection = "csi_section" in safe
  if (changesProject || changesSection) {
    const { data: existing } = await supabase
      .from("submittals")
      .select("submittal_seq, project_id, csi_section, section_seq")
      .eq("id", id)
      .single()

    if (changesProject) {
      const needsNumber =
        !!existing && (existing.submittal_seq == null || existing.project_id !== safe.project_id)
      if (needsNumber) {
        const { data: seqBase } = await supabase
          .rpc("next_submittal_seq", { p_project_id: safe.project_id, p_count: 1 })
        if (typeof seqBase === "number") safe.submittal_seq = seqBase + 1
      }
    }

    const destProject = changesProject ? (safe.project_id as string) : (existing?.project_id ?? null)
    const destSection = changesSection
      ? (typeof safe.csi_section === "string" ? safe.csi_section : null)
      : (existing?.csi_section ?? null)
    const placementMoved =
      !!existing && (destProject !== existing.project_id || destSection !== existing.csi_section)

    // Only re-number a row that actually MOVED and already carried a number.
    if (placementMoved && destProject && destSection && existing!.section_seq != null) {
      for (let attempt = 0; attempt < 5; attempt++) {
        safe.section_seq = (await maxSectionSeq(supabase, destProject, destSection)) + 1
        const { error } = await supabase.from("submittals").update(safe).eq("id", id)
        if (!error) return NextResponse.json({ ok: true })
        if (isSectionSeqConflict(error) && attempt < 4) continue
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ error: "could not allocate a unique section number" }, { status: 500 })
    }
  }

  const { error } = await supabase.from("submittals").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: row, error: selErr } = await supabase
    .from("submittals").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Spec-ingestion rows USED to be gated here (409 "clear the file instead")
  // on the theory that a spec row is the spec book's requirement and must
  // survive as a placeholder. Product decision (Jace, 2026-07-17) REVERSED
  // that: the parser over-extracts, junk rows land in the log, and deleting
  // them must be a click — not a SQL remediation. Every row kind is now
  // soft-deletable. Clearing the file while KEEPING the row remains available
  // as the separate "clear" action on /library-delete. The deleted row keeps
  // its section_seq, so its CM number is retired, never reused (0039 index +
  // maxSectionSeq count soft-deleted rows), and survivors' numbers are stable.
  // NOTE: this route soft-deletes the ROW ONLY — it does not touch attachment
  // rows or storage objects. UI deletion goes through /library-delete, which
  // cleans those up too.

  const { error } = await supabase
    .from("submittals")
    .update({ status: "deleted" })
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
