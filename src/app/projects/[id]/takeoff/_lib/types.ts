// Bid Takeoff — row shapes. These mirror the takeoff_* tables (base: migration
// 0025; measurement columns + takeoff_page_scales: migration 0032, Phase B).
// Future-seam columns on takeoff_tags (spec_number, spec_section_id, unit_cost,
// vendor_id, vendor_person_id) are intentionally omitted here — not surfaced.

// A normalized [0,1] page point stored as a compact [x,y] pair (jsonb array).
export type Pt = [number, number]

// What a mark measures. 'count' = a single dot (uses x,y — the original Phase A
// behavior). 'linear'/'area' carry an ordered `points` polyline/polygon and a
// pre-scale `raw_measure`; x,y is the label anchor (first vertex / centroid).
export type MarkKind = "count" | "linear" | "area"

// Calibration unit the user picks when setting a page's scale.
export type ScaleUnit = "ft" | "in" | "m"

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
  /** Label anchor (normalized). For count this is the dot; for linear/area the
   *  first vertex / centroid. Always set (the column is NOT NULL). */
  x: number
  y: number
  kind: MarkKind
  /** Ordered normalized vertices — null for count, set for linear/area. */
  points: Pt[] | null
  /** Geometric measure in the aspect-corrected normalized space (segment length
   *  for linear, polygon area for area), pre-scale. null for count. Real-world
   *  value is resolved at read time via the page's scale — never stored. */
  raw_measure: number | null
}

// One scale calibration per (takeoff, sheet, page) — migrations 0032 + 0033. A
// scale belongs to a SHEET (`source_ref` = drawing_sheets id, matching a mark's
// source_ref), not just a viewer page index, because multiple sheets each open at
// page 0. `units_per_px` is the real-world units per unit of aspect-corrected
// normalized page distance (see _lib/measure.ts). cal_* is the drawn calibration
// segment (normalized), kept so the calibration is re-editable.
// UNIQUE NULLS NOT DISTINCT (takeoff_id, source_ref, page): recalibrating a sheet
// page UPSERTs its single row (null source_ref collapses to one row too).
// company_id is stamped server-side (never sent).
export interface TakeoffPageScale {
  id: string
  takeoff_id: string
  source_ref: string | null
  page: number
  units_per_px: number
  unit: ScaleUnit
  cal_x1: number
  cal_y1: number
  cal_x2: number
  cal_y2: number
}

export interface TakeoffBundle {
  takeoff: Takeoff
  categories: TakeoffCategory[]
  rooms: TakeoffRoom[]
  tags: TakeoffTag[]
  marks: TakeoffMark[]
  page_scales: TakeoffPageScale[]
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
