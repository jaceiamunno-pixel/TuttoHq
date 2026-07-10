// Short-lived, presence-only marker proving the current /auth/reset-password
// visit immediately followed a just-consumed recovery link.
//
// It is NOT a bearer of anything and authorizes nothing on its own:
// /auth/reset-password requires a live session AND this marker. See
// src/app/auth/reset-password/page.tsx for the full rationale — why a marker
// instead of the session type, and exactly which residual it does and does not
// close.
export const RECOVERY_MARKER_COOKIE = "ttq_recovery_intent"

// Minutes, not hours: the reset form is submitted right after the callback.
const MARKER_TTL_SECONDS = 5 * 60

// Client-only (document.cookie). Never called during SSR. Scoped to /auth so it
// rides the callback → reset-password navigation and nothing wider. `Secure`
// only over https so it still works on http://localhost in dev.
export function setRecoveryMarker() {
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `${RECOVERY_MARKER_COOKIE}=1; Path=/auth; Max-Age=${MARKER_TTL_SECONDS}; SameSite=Lax${secure}`
}

export function clearRecoveryMarker() {
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `${RECOVERY_MARKER_COOKIE}=; Path=/auth; Max-Age=0; SameSite=Lax${secure}`
}
