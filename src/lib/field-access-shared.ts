// ADR-020 field role — client-safe shared constants/types. No server imports
// here (this file is bundled into client components); the server-side guards
// live in @/lib/field-access, which re-exports these.

export const FIELD_MODULES = ["daily_reports", "drawings", "schedule", "rfis"] as const
export type FieldModule = (typeof FIELD_MODULES)[number]

export const FIELD_MODULE_LABELS: Record<FieldModule, string> = {
  daily_reports: "Daily Reports",
  drawings:      "Drawings",
  schedule:      "Schedule",
  rfis:          "RFIs",
}

export type FieldGrant = { project_id: string; module: FieldModule; can_edit: boolean }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isFieldModule(m: string): m is FieldModule {
  return (FIELD_MODULES as readonly string[]).includes(m)
}

/** Normalize an untrusted grants payload: drop malformed/unknown entries,
 *  dedupe on (project_id, module). Returns the count dropped so callers can
 *  log/reject. */
export function parseGrants(raw: unknown): { grants: FieldGrant[]; invalid: number } {
  if (!Array.isArray(raw)) return { grants: [], invalid: 0 }
  const seen = new Set<string>()
  const grants: FieldGrant[] = []
  let invalid = 0
  for (const g of raw) {
    const project_id = typeof g?.project_id === "string" ? g.project_id : ""
    const module     = typeof g?.module === "string" ? g.module : ""
    if (!UUID_RE.test(project_id) || !isFieldModule(module)) { invalid++; continue }
    const key = `${project_id}:${module}`
    if (seen.has(key)) continue
    seen.add(key)
    grants.push({ project_id, module, can_edit: g?.can_edit === true })
  }
  return { grants, invalid }
}
