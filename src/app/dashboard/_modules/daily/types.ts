// Shared types + helpers for the decomposed Daily Reports module.
// Every component in this directory accepts `canEdit` (the field-role
// read-only seam, ADR-020) — default true until the role plumbing lands.

import type { DailyReport } from "../../_shared/types"

/** One crew line: label/trade, headcount, hours. Stored in
 *  daily_reports.crew (jsonb) once migration 0050 is live. */
export interface CrewRow {
  trade: string
  count: number | null
  hours: number | null
}

/** The composer's single form-state bag. Keys of the string fields mirror
 *  the daily_reports columns AND the IDB draft `fields` bag exactly, so
 *  pre-existing drafts restore unchanged. `crew` serializes to a JSON
 *  string inside the bag (Record<string,string> shape is preserved). */
export interface DailyForm {
  report_date: string
  project_id: string
  prepared_by: string
  weather_conditions: string
  temperature: string
  manpower_count: string
  work_performed: string
  equipment: string
  materials_delivered: string
  visitors: string
  issues_delays: string
  safety_notes: string
  crew: CrewRow[]
}

export function emptyDailyForm(projectId = ""): DailyForm {
  return {
    report_date: new Date().toISOString().slice(0, 10),
    project_id: projectId,
    prepared_by: "",
    weather_conditions: "",
    temperature: "",
    manpower_count: "",
    work_performed: "",
    equipment: "",
    materials_delivered: "",
    visitors: "",
    issues_delays: "",
    safety_notes: "",
    crew: [],
  }
}

export const WEATHER_OPTIONS = ["Clear", "Partly Cloudy", "Cloudy", "Rain", "Heavy Rain", "Snow", "Fog", "Wind"]

/** Derived headcount total — shown on list rows and written to
 *  manpower_count on save for back-compat with existing readers. */
export function crewHeadcount(crew: CrewRow[] | null | undefined): number {
  return (crew ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0)
}

export function crewHours(crew: CrewRow[] | null | undefined): number {
  return (crew ?? []).reduce((sum, r) => sum + (r.hours ?? 0), 0)
}

/** Parse the crew JSON string out of an IDB draft/pending fields bag.
 *  Tolerant of anything — a bad string is an empty crew, never a throw. */
export function parseCrewJson(raw: string | undefined | null): CrewRow[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map(r => ({
        trade: typeof r.trade === "string" ? r.trade : "",
        count: typeof r.count === "number" && Number.isFinite(r.count) ? r.count : null,
        hours: typeof r.hours === "number" && Number.isFinite(r.hours) ? r.hours : null,
      }))
  } catch {
    return []
  }
}

/** Crew rows worth persisting (some content beyond a blank line). */
export function nonEmptyCrew(crew: CrewRow[]): CrewRow[] {
  return crew.filter(r => r.trade.trim() !== "" || r.count != null || r.hours != null)
}

export function isSubmitted(r: DailyReport): boolean {
  return r.status === "submitted"
}

/** "Edited after submission" is shown only when both signals exist and the
 *  edit is newer — legacy rows (no updated_at) never trigger it. */
export function editedAfterSubmit(r: DailyReport): boolean {
  if (!isSubmitted(r) || !r.submitted_at || !r.updated_at) return false
  return new Date(r.updated_at).getTime() > new Date(r.submitted_at).getTime()
}

/** Server photo shape returned by GET /api/photos (caption present only
 *  once 0050 is live). */
export interface ServerPhoto {
  id: string
  url: string
  file_name: string | null
  caption?: string | null
}
