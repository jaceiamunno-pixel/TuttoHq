// Reversible feature flags. These hide a feature from the UI WITHOUT removing
// any code, route, table, or data — flip a value back to `true` to bring the
// feature back in one line.
//
//  - punchList: Punch List is hidden from the nav, its direct route returns 404,
//    and the Closeout "Go to Punch" banner is suppressed. The PunchModule,
//    /projects/[id]/punch route, /api/punch routes, and punch_items table all
//    remain fully intact. Set to `true` to re-enable.
export const FEATURES = {
  punchList: false,
} as const

export type FeatureKey = keyof typeof FEATURES

export function isFeatureEnabled(key: FeatureKey): boolean {
  return FEATURES[key]
}
