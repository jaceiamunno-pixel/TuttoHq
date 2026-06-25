// Bid Takeoff — row shapes (count-only pass). These mirror the takeoff_* tables
// (migration 0025). Future-seam columns on takeoff_tags (spec_number,
// spec_section_id, unit_cost, vendor_id, vendor_person_id) are intentionally
// omitted here — not surfaced, not written this pass.

export interface Takeoff {
  id: string
  project_id: string
  name: string
  created_at: string
}

export interface TakeoffCategory {
  id: string
  takeoff_id: string
  name: string
  sort_order: number
}

export interface TakeoffRoom {
  id: string
  takeoff_id: string
  name: string
  sort_order: number
}

export interface TakeoffTag {
  id: string
  takeoff_id: string
  category_id: string | null
  code: string
  description: string | null
  color: string
  sort_order: number
}

export interface TakeoffMark {
  id: string
  takeoff_id: string
  tag_id: string
  room_id: string
  source_ref: string | null
  page: number
  x: number
  y: number
}

export interface TakeoffBundle {
  takeoff: Takeoff
  categories: TakeoffCategory[]
  rooms: TakeoffRoom[]
  tags: TakeoffTag[]
  marks: TakeoffMark[]
}

// A drawing sheet the user counts on — sourced from the Drawings section's
// drawing_sheets table via GET /api/drawings/sheets (NOT the legacy drawing_log).
// `id` is drawing_sheets.id: stable across revisions, stored as each mark's
// source_ref; `file_url` is the (ephemeral, signed) current-revision PDF the
// viewer renders.
export interface CountSheet {
  id: string
  sheet_number: string | null
  sheet_title: string | null
  file_url: string | null
}
