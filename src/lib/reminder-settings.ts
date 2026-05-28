// ─── Reminder settings — single source of truth (Session K2) ────────────────
// The COALESCE resolution from per-package override -> company default ->
// hardcoded fallback lives here exclusively, so the cron's actual behavior
// (reminders.ts) and the UI's "effective" display (settings GET route) can
// never disagree about what's going to happen.
//
// The hardcoded fallback values match the Phase 1 column DEFAULTs on
// company_settings. They're a backstop for the case where a company row
// somehow has NULL in those columns (shouldn't be possible given NOT NULL,
// but cheaper to defend than to debug a NaN later).

// Hardcoded backstop — mirrors the company_settings column DEFAULTs.
export const FALLBACK_CADENCE: number[] = [7, 14]
export const FALLBACK_MAX_COUNT = 2
export const FALLBACK_ATTACH_PDF = false

// Sanity ceiling — a 6-month cadence value is almost certainly a typo, not
// a legitimate workflow. Mirrored client-side and server-side.
export const MAX_CADENCE_DAY = 90
export const MAX_REMINDER_COUNT = 10

// ─── Input shapes ───────────────────────────────────────────────────────────

/** The four override columns that live on submittal_packages / closeout_packages. */
export interface PackageReminderOverrides {
  reminder_cadence_days: number[] | null
  reminder_max_count:    number   | null
  reminder_attach_pdf:   boolean  | null
  reminders_paused:      boolean
}

/** The company-wide defaults from company_settings. */
export interface CompanyReminderDefaults {
  reminder_cadence_days:       number[] | null
  reminder_max_count:          number   | null
  reminder_default_attach_pdf: boolean  | null
}

// ─── Effective values ───────────────────────────────────────────────────────

export interface EffectiveReminderSettings {
  effective_cadence:        number[]
  effective_max:            number
  effective_attach:         boolean
  /**
   * The actual ceiling on how many reminders will ever go out for the package:
   * min(cadence.length, max). A cadence shorter than the max effectively caps
   * the count. Exposed so the UI and cron both bound off the same number.
   */
  effective_max_reminders:  number
}

/**
 * COALESCE per-package overrides -> company defaults -> hardcoded fallbacks.
 * Used by both the cron (decides whether to send) and the settings GET route
 * (decides what to show). Pure function — no IO, no DB.
 */
export function resolveEffectiveSettings(
  pkg:     PackageReminderOverrides,
  company: CompanyReminderDefaults | null,
): EffectiveReminderSettings {
  const cadence = pkg.reminder_cadence_days
    ?? company?.reminder_cadence_days
    ?? FALLBACK_CADENCE
  const max     = pkg.reminder_max_count
    ?? company?.reminder_max_count
    ?? FALLBACK_MAX_COUNT
  const attach  = pkg.reminder_attach_pdf
    ?? company?.reminder_default_attach_pdf
    ?? FALLBACK_ATTACH_PDF

  return {
    effective_cadence: cadence,
    effective_max:     max,
    effective_attach:  attach,
    effective_max_reminders: Math.min(cadence.length, max),
  }
}

// ─── Observability helpers (for the GET route's reminder_settings object) ──

/**
 * The Date the next reminder fires, or null when no further reminder is due.
 * Null cases (ordered by precedence):
 *   - reminders_paused = true
 *   - dispatched_at is null (package not dispatched yet)
 *   - sent_count >= effective_max_reminders (cap hit)
 * Returned as an ISO string so it round-trips through JSON unchanged.
 */
export function computeNextDueAt(
  dispatchedAt:        string | null,
  sentCount:           number,
  reminders_paused:    boolean,
  effective:           EffectiveReminderSettings,
): string | null {
  if (reminders_paused) return null
  if (!dispatchedAt)    return null
  if (sentCount >= effective.effective_max_reminders) return null
  const dayOffset = effective.effective_cadence[sentCount]
  if (typeof dayOffset !== "number") return null   // belt-and-suspenders
  const base = new Date(dispatchedAt).getTime()
  return new Date(base + dayOffset * 86_400_000).toISOString()
}

// ─── Validation (used by both PATCH /settings routes) ──────────────────────

export type ValidationResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: string }

export interface ValidatedSettingsPatch {
  reminder_cadence_days?: number[] | null
  reminder_max_count?:    number   | null
  reminder_attach_pdf?:   boolean  | null
  reminders_paused?:      boolean
}

/**
 * Validate a PATCH /settings body. Each field is optional — only validated
 * if the caller actually provided it. null is the explicit "clear override
 * and inherit" signal for the three override fields; reminders_paused is
 * boolean-only (no inherit semantics, since it lives only on the package).
 */
export function validateSettingsBody(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
): ValidationResult<ValidatedSettingsPatch> {
  const out: ValidatedSettingsPatch = {}

  if ("reminder_cadence_days" in body) {
    const raw = body.reminder_cadence_days
    if (raw === null) {
      out.reminder_cadence_days = null
    } else if (!Array.isArray(raw)) {
      return { ok: false, error: "reminder_cadence_days must be an array or null" }
    } else if (raw.length === 0) {
      // Empty array would mean "0 reminders ever" — but that's already
      // expressible via reminder_max_count = 0 or reminders_paused. Reject
      // here so the cron never receives an ambiguous shape.
      return { ok: false, error: "Cadence cannot be empty — leave it blank to inherit the company default" }
    } else {
      const nums: number[] = []
      let prev = 0
      for (const v of raw) {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          return { ok: false, error: "Cadence values must be whole numbers" }
        }
        if (v <= 0) {
          return { ok: false, error: "Cadence values must be greater than zero" }
        }
        if (v > MAX_CADENCE_DAY) {
          return { ok: false, error: `Cadence values must be ${MAX_CADENCE_DAY} days or fewer` }
        }
        if (v <= prev) {
          return { ok: false, error: "Cadence values must be strictly ascending (no duplicates)" }
        }
        nums.push(v)
        prev = v
      }
      out.reminder_cadence_days = nums
    }
  }

  if ("reminder_max_count" in body) {
    const raw = body.reminder_max_count
    if (raw === null) {
      out.reminder_max_count = null
    } else if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { ok: false, error: "Max reminders must be a whole number" }
    } else if (raw < 1 || raw > MAX_REMINDER_COUNT) {
      return { ok: false, error: `Max reminders must be between 1 and ${MAX_REMINDER_COUNT}` }
    } else {
      out.reminder_max_count = raw
    }
  }

  if ("reminder_attach_pdf" in body) {
    const raw = body.reminder_attach_pdf
    if (raw !== null && typeof raw !== "boolean") {
      return { ok: false, error: "reminder_attach_pdf must be true, false, or null" }
    }
    out.reminder_attach_pdf = raw
  }

  if ("reminders_paused" in body) {
    if (typeof body.reminders_paused !== "boolean") {
      return { ok: false, error: "reminders_paused must be true or false" }
    }
    out.reminders_paused = body.reminders_paused
  }

  return { ok: true, value: out }
}

// ─── Tiny formatter the UI can reuse so the cadence renders the same way
//     in inputs, hints, and the right-column display ──────────────────────────
export function formatCadence(cadence: number[]): string {
  return cadence.join(", ")
}

/** Parse a comma-separated input back into a number[] for the PATCH body. */
export function parseCadenceInput(input: string): number[] | null {
  const trimmed = input.trim()
  if (trimmed === "") return null   // empty = inherit (caller wraps to null)
  return trimmed
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => !Number.isNaN(n))
}
