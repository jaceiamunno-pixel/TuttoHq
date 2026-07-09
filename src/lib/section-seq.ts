import type { SupabaseClient } from "@supabase/supabase-js"

// section_seq allocation (migration 0039).
//
// A per-(project_id, csi_section) submittal number, enforced by a partial unique
// index: idx_submittals_section_seq_unique ON submittals(project_id, csi_section,
// section_seq) WHERE section_seq IS NOT NULL. An INSERT with a colliding tuple
// FAILS (23505), so every creation path must allocate correctly.
//
// Allocation rule: next = COALESCE(MAX(section_seq), 0) + 1 for that
// (project, section), counting ALL rows INCLUDING soft-deleted ones — a retired
// number is NEVER reused (a number sent to a CM must never later point at a
// different document). We therefore run NO status filter on the max lookup.
//
// Concurrency: the guarded MAX has a read→insert gap, so two concurrent creates
// in one section can compute the same next value. The unique index rejects the
// loser with 23505; `allocateSectionSeqAndInsert` catches that, recomputes the
// max, and retries. This is the "guarded max" the numbering contract calls for
// without a counter table.

/** Highest existing section_seq for one (project, csi_section), counting ALL
 *  rows including soft-deleted (no status filter). 0 when none are numbered.
 *  Filtered by project_id, which is company-unique, so this is correct even
 *  under a service-role client that bypasses RLS. */
export async function maxSectionSeq(
  supabase: SupabaseClient,
  projectId: string,
  csiSection: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("submittals")
    .select("section_seq")
    .eq("project_id", projectId)
    .eq("csi_section", csiSection)
    .not("section_seq", "is", null)
    .order("section_seq", { ascending: false })
    .limit(1)
  if (error) throw new Error(`section_seq lookup failed: ${error.message}`)
  const top = data && data.length > 0 ? (data[0].section_seq as number | null) : null
  return top ?? 0
}

/** True when a PostgREST error is a unique-violation on the section_seq index. */
export function isSectionSeqConflict(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  return err.code === "23505" && /section_seq/i.test(err.message ?? "")
}

/**
 * Current MAX(section_seq) for EACH distinct section in one project, counting
 * ALL rows incl soft-deleted. ONE round-trip (not one-per-row) — the bulk paths
 * (spec ingestion) must not loop a per-row max. Returns section → max (0 when a
 * section has no numbered rows yet).
 */
export async function sectionSeqStarts(
  supabase: SupabaseClient,
  projectId: string,
  sections: (string | null | undefined)[],
): Promise<Map<string, number>> {
  const uniq = [...new Set(sections.map(s => (s ?? "").trim()).filter(Boolean))]
  const startBy = new Map<string, number>(uniq.map(s => [s, 0]))
  if (uniq.length === 0) return startBy
  const { data, error } = await supabase
    .from("submittals")
    .select("csi_section, section_seq")
    .eq("project_id", projectId)
    .in("csi_section", uniq)
    .not("section_seq", "is", null)
  if (error) throw new Error(`section_seq batch lookup failed: ${error.message}`)
  for (const r of data ?? []) {
    const sec = (r.csi_section as string | null) ?? ""
    const seq = (r.section_seq as number | null) ?? 0
    if (seq > (startBy.get(sec) ?? 0)) startBy.set(sec, seq)
  }
  return startBy
}

/**
 * Stamp section_seq onto a block of rows-to-insert in ONE pass: each section's
 * rows are numbered start+1, start+2, … off that section's current MAX (mirrors
 * the migration's row_number() OVER (PARTITION BY project_id, csi_section)). Rows
 * with no section are left null (the partial index ignores nulls). Mutates rows
 * in place. Call `sectionSeqStarts` fresh on each retry so a re-read of MAX
 * follows a conflict — never increment a stale block.
 */
export function assignSectionSeqBlock(
  rows: Record<string, unknown>[],
  starts: Map<string, number>,
): void {
  const running = new Map<string, number>()
  for (const row of rows) {
    const sec = ((row.csi_section as string | null) ?? "").trim()
    if (!sec) { row.section_seq = null; continue }
    const next = (running.get(sec) ?? starts.get(sec) ?? 0) + 1
    running.set(sec, next)
    row.section_seq = next
  }
}

/**
 * Insert one submittals row, allocating section_seq for its section under the
 * unique index with bounded retry-on-conflict.
 *
 * `buildRow(sectionSeq)` returns the full insert payload with the given
 * section_seq stamped in. When `csiSection` is null/empty (e.g. a Library shelf
 * upload with no section), the row can't be numbered per section — it's inserted
 * once with section_seq = null (the partial index ignores nulls).
 *
 * Returns the selected row (`.single()`) or an error string. Never throws.
 */
export async function allocateSectionSeqAndInsert<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  projectId: string | null | undefined,
  csiSection: string | null | undefined,
  buildRow: (sectionSeq: number | null) => Record<string, unknown>,
  selectCols: string,
): Promise<{ data: T | null; error: string | null }> {
  const section = (csiSection ?? "").trim()
  if (!projectId || !section) {
    const { data, error } = await supabase
      .from("submittals").insert(buildRow(null)).select(selectCols).single()
    return { data: (data as T) ?? null, error: error?.message ?? null }
  }

  const MAX_ATTEMPTS = 6
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let seq: number
    try {
      seq = (await maxSectionSeq(supabase, projectId, section)) + 1
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : "section_seq lookup failed" }
    }
    const { data, error } = await supabase
      .from("submittals").insert(buildRow(seq)).select(selectCols).single()
    if (!error) return { data: data as T, error: null }
    // Another create took this number first — recompute and retry.
    if (isSectionSeqConflict(error) && attempt < MAX_ATTEMPTS - 1) continue
    return { data: null, error: error.message }
  }
  return { data: null, error: "could not allocate a unique section number after retries" }
}
