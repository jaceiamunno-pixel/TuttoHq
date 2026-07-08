import type { MarkKind, TakeoffCategory, TakeoffRoom, TakeoffTag, TakeoffMark, TakeoffPageScale } from "./types"
import { resolveMeasure, measuredUnitLabel, scaleKey } from "./measure"

// Pure tag×room matrix — the single source of truth for BOTH the on-screen table
// and the Excel export, so they can never drift. Rows are tags grouped under their
// category; columns are the rooms (the TOTAL column is the row sum). Each category
// gets a subtotal row and the sheet a grand-total row.
//
// Phase B — count XOR measured. A tag's kind is DERIVED from its marks: a tag with
// any linear/area marks is a measured tag (summing real-world quantity resolved at
// read time from the page scales); otherwise it's a count tag (summing dots, the
// original behavior). Because a category can hold both count tags and measured
// tags — or measured tags in different units — a subtotal/grand-total is only
// meaningful when every contributing row shares one unit; when they don't, the
// total is `null` (the UI/export render it as "—") rather than adding apples to
// oranges. Per-tag row totals are always in a single unit, so always valid.

// Unit-key groups rows that CAN be summed together: all count rows share "#"; a
// measured row's key is its unit label (e.g. "SF"). A measured row whose pages are
// all unscaled has no resolvable unit → null key → never folded into a subtotal.
const COUNT_KEY = "#"

export interface MatrixTagRow {
  tag: TakeoffTag
  kind: MarkKind
  /** Display unit for a measured tag ("LF"/"SF"/"m²"/…); null for count or when
   *  the tag's pages are all unscaled (nothing to price against). */
  unitLabel: string | null
  perRoom: number[]      // indexed by matrix.rooms order — counts OR real quantities
  total: number
  /** True when some of this tag's measured marks sit on pages with no scale (they
   *  are excluded from the sums; the UI flags "needs scale"). */
  missingScale: boolean
}

export interface MatrixGroup {
  id: string             // category id, or "__uncat__"
  name: string
  rows: MatrixTagRow[]
  /** Shared unit label for the subtotal ("" = count); null when the group mixes
   *  units and so cannot be subtotalled. */
  unitLabel: string | null
  subtotalPerRoom: number[] | null
  subtotalTotal: number | null
}

export interface TakeoffMatrix {
  rooms: TakeoffRoom[]
  groups: MatrixGroup[]
  grandUnitLabel: string | null
  grandPerRoom: number[] | null
  grandTotal: number | null
}

const UNCAT = "__uncat__"

function bySort<T extends { sort_order: number }>(a: T, b: T) {
  return a.sort_order - b.sort_order
}

const unitKeyOf = (row: MatrixTagRow): string | null =>
  row.kind === "count" ? COUNT_KEY : row.unitLabel

/** Fold a set of rows into a per-room total + grand only when they share one unit.
 *  Returns unitLabel="" for count, the unit string for a measured unit, or null
 *  (uncomputable) when the rows mix units. */
function foldRows(rows: MatrixTagRow[], roomCount: number): {
  unitLabel: string | null
  perRoom: number[] | null
  total: number | null
} {
  const keys = new Set(rows.map(unitKeyOf))
  const key = keys.size <= 1 ? (rows.length ? unitKeyOf(rows[0]) : COUNT_KEY) : null
  if (key === null) return { unitLabel: null, perRoom: null, total: null }
  const perRoom = Array.from({ length: roomCount }, (_, i) => rows.reduce((a, r) => a + r.perRoom[i], 0))
  return {
    unitLabel: key === COUNT_KEY ? "" : key,
    perRoom,
    total: perRoom.reduce((a, b) => a + b, 0),
  }
}

export function computeMatrix(
  categories: TakeoffCategory[],
  rooms: TakeoffRoom[],
  tags: TakeoffTag[],
  marks: TakeoffMark[],
  scales: TakeoffPageScale[],
): TakeoffMatrix {
  const sortedRooms = [...rooms].sort(bySort)
  const roomIndex = new Map(sortedRooms.map((r, i) => [r.id, i]))
  const tagIds = new Set(tags.map(t => t.id))
  // Scale is keyed by (sheet, page) so a mark prices against its OWN sheet's scale.
  const scaleByKey = new Map<string, TakeoffPageScale>()
  for (const s of scales) scaleByKey.set(scaleKey(s.source_ref, s.page), s)

  // tagId → its marks (only tags that exist in this takeoff)
  const marksByTag = new Map<string, TakeoffMark[]>()
  for (const m of marks) {
    if (!tagIds.has(m.tag_id)) continue
    if (!marksByTag.has(m.tag_id)) marksByTag.set(m.tag_id, [])
    marksByTag.get(m.tag_id)!.push(m)
  }

  const buildRow = (tag: TakeoffTag): MatrixTagRow => {
    const tagMarks = marksByTag.get(tag.id) ?? []
    // A tag is one kind: measured if it has any linear/area mark, else count.
    const measured = tagMarks.find(m => m.kind === "linear" || m.kind === "area")
    const kind: MarkKind = measured ? measured.kind : "count"
    const perRoom = new Array(sortedRooms.length).fill(0)
    let missingScale = false
    let unitLabel: string | null = null

    for (const m of tagMarks) {
      const ri = roomIndex.get(m.room_id)
      if (ri === undefined) continue
      if (kind === "count") {
        if (m.kind !== "count") continue        // defensive: ignore stray measured mark
        perRoom[ri] += 1
      } else {
        if (m.kind !== kind) continue            // only same-kind marks contribute
        const scale = scaleByKey.get(scaleKey(m.source_ref, m.page))
        const real = resolveMeasure(m.kind, m.raw_measure, scale)
        if (real == null) { missingScale = true; continue }  // page not scaled yet
        perRoom[ri] += real
        if (!unitLabel) unitLabel = measuredUnitLabel(kind, scale!.unit)
      }
    }
    return { tag, kind, unitLabel, perRoom, total: perRoom.reduce((a, b) => a + b, 0), missingScale }
  }

  const tagsByCat = new Map<string, TakeoffTag[]>()
  const catIds = new Set(categories.map(c => c.id))
  for (const t of [...tags].sort(bySort)) {
    const key = t.category_id && catIds.has(t.category_id) ? t.category_id : UNCAT
    if (!tagsByCat.has(key)) tagsByCat.set(key, [])
    tagsByCat.get(key)!.push(t)
  }

  const buildGroup = (id: string, name: string, groupTags: TakeoffTag[]): MatrixGroup => {
    const rows = groupTags.map(buildRow)
    const folded = foldRows(rows, sortedRooms.length)
    return { id, name, rows, unitLabel: folded.unitLabel, subtotalPerRoom: folded.perRoom, subtotalTotal: folded.total }
  }

  const groups: MatrixGroup[] = []
  for (const c of [...categories].sort(bySort)) {
    groups.push(buildGroup(c.id, c.name, tagsByCat.get(c.id) ?? []))
  }
  const uncat = tagsByCat.get(UNCAT)
  if (uncat && uncat.length) groups.push(buildGroup(UNCAT, "Uncategorized", uncat))

  const grand = foldRows(groups.flatMap(g => g.rows), sortedRooms.length)
  return {
    rooms: sortedRooms,
    groups,
    grandUnitLabel: grand.unitLabel,
    grandPerRoom: grand.perRoom,
    grandTotal: grand.total,
  }
}
