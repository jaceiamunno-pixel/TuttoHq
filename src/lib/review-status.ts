// Canonical submittal review_status vocabulary (Jace-approved 2026-07-17,
// enforced in the DB by migration 0046's CHECK constraint). Lifecycle order:
//
//   Not Started → Received → Sent to A/E
//     → Approved | Approved as Noted | Revise & Resubmit | Rejected → Closed
//
// Every writer of submittals.review_status must emit ONLY these values —
// the DB CHECK rejects anything else once 0046 runs. Keep this list, the
// CHECK's IN list, badges.tsx STATUS_STYLES, and excel-export.ts STATUS_FILL
// in lockstep.
export const REVIEW_STATUSES = [
  "Not Started",
  "Received",
  "Sent to A/E",
  "Approved",
  "Approved as Noted",
  "Revise & Resubmit",
  "Rejected",
  "Closed",
] as const

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** Review outcomes assignable in Bulk Import (the returned-from-A/E subset). */
export const REVIEW_OUTCOMES = [
  "Approved", "Approved as Noted", "Revise & Resubmit", "Rejected",
] as const
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number]

export function isReviewStatus(v: unknown): v is ReviewStatus {
  return typeof v === "string" && (REVIEW_STATUSES as readonly string[]).includes(v)
}
