import type { TakeoffCategory, TakeoffRoom, TakeoffTag, TakeoffMark } from "./types"

// Pure tag×room matrix — the single source of truth for BOTH the on-screen table
// and the Excel export, so they can never drift. Rows are tags grouped under their
// category; columns are the rooms (the TOTAL column is the row sum). Each category
// gets a subtotal row and the sheet a grand-total row.

export interface MatrixTagRow {
  tag: TakeoffTag
  perRoom: number[]   // indexed by matrix.rooms order
  total: number
}

export interface MatrixGroup {
  id: string          // category id, or "__uncat__"
  name: string
  rows: MatrixTagRow[]
  subtotalPerRoom: number[]
  subtotalTotal: number
}

export interface TakeoffMatrix {
  rooms: TakeoffRoom[]
  groups: MatrixGroup[]
  grandPerRoom: number[]
  grandTotal: number
}

const UNCAT = "__uncat__"

function bySort<T extends { sort_order: number }>(a: T, b: T) {
  return a.sort_order - b.sort_order
}

export function computeMatrix(
  categories: TakeoffCategory[],
  rooms: TakeoffRoom[],
  tags: TakeoffTag[],
  marks: TakeoffMark[],
): TakeoffMatrix {
  const sortedRooms = [...rooms].sort(bySort)
  const roomIndex = new Map(sortedRooms.map((r, i) => [r.id, i]))
  const tagIds = new Set(tags.map(t => t.id))

  // tagId → counts-by-room-index
  const counts = new Map<string, number[]>()
  for (const t of tags) counts.set(t.id, new Array(sortedRooms.length).fill(0))
  for (const m of marks) {
    if (!tagIds.has(m.tag_id)) continue
    const ri = roomIndex.get(m.room_id)
    if (ri === undefined) continue
    counts.get(m.tag_id)![ri] += 1
  }

  const tagsByCat = new Map<string, TakeoffTag[]>()
  const catIds = new Set(categories.map(c => c.id))
  for (const t of [...tags].sort(bySort)) {
    const key = t.category_id && catIds.has(t.category_id) ? t.category_id : UNCAT
    if (!tagsByCat.has(key)) tagsByCat.set(key, [])
    tagsByCat.get(key)!.push(t)
  }

  const buildGroup = (id: string, name: string, groupTags: TakeoffTag[]): MatrixGroup => {
    const rows: MatrixTagRow[] = groupTags.map(tag => {
      const perRoom = counts.get(tag.id) ?? new Array(sortedRooms.length).fill(0)
      return { tag, perRoom, total: perRoom.reduce((a, b) => a + b, 0) }
    })
    const subtotalPerRoom = sortedRooms.map((_, i) => rows.reduce((a, r) => a + r.perRoom[i], 0))
    return { id, name, rows, subtotalPerRoom, subtotalTotal: subtotalPerRoom.reduce((a, b) => a + b, 0) }
  }

  const groups: MatrixGroup[] = []
  for (const c of [...categories].sort(bySort)) {
    groups.push(buildGroup(c.id, c.name, tagsByCat.get(c.id) ?? []))
  }
  const uncat = tagsByCat.get(UNCAT)
  if (uncat && uncat.length) groups.push(buildGroup(UNCAT, "Uncategorized", uncat))

  const grandPerRoom = sortedRooms.map((_, i) => groups.reduce((a, g) => a + g.subtotalPerRoom[i], 0))
  return {
    rooms: sortedRooms,
    groups,
    grandPerRoom,
    grandTotal: grandPerRoom.reduce((a, b) => a + b, 0),
  }
}
