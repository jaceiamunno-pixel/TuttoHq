// Last-opened project, remembered client-side so the daily-report flow stays
// reachable offline (ADR-009 Phase 1, Step 1.1). The dashboard's project grid is
// /api-driven (empty in a dead zone), so without this there is no way to enter a
// project's daily report on an offline cold launch. localStorage is synchronous
// and offline-readable; we keep only what the offline entry needs.
const KEY = "tutto:last-project"

export interface LastProject {
  id: string
  name: string
}

export function rememberLastProject(p: LastProject): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ id: p.id, name: p.name }))
  } catch {
    // private mode / storage disabled — non-fatal; the offline shortcut just
    // won't be available.
  }
}

export function readLastProject(): LastProject | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v.id === "string" ? { id: v.id, name: String(v.name ?? "") } : null
  } catch {
    return null
  }
}
