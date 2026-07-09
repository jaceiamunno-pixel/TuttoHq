import { Capacitor } from "@capacitor/core"

/**
 * Client-side half of the ADR-010 auth transport (the server half shipped in
 * #66: createClientFromRequest + middleware CORS/bearer).
 *
 * ONE wrapper that every client `/api` call should go through. Behaviour splits
 * on platform:
 *   • Web  → relative `/api/...` + cookie auth. Byte-identical to a raw fetch()
 *            today; no bearer header, no cross-origin. Web is NOT regressed.
 *   • Native (Capacitor) → absolute `${API_BASE_URL}/api/...` + an
 *            `Authorization: Bearer <access_token>` header pulled from the
 *            current supabase-js session. The native bundle has no cookie jar
 *            and calls the deployed API cross-origin, so the bearer is the only
 *            credential — exactly what the #66 server seam validates.
 *
 * Transport note: CapacitorHttp is enabled in capacitor.config.ts, which patches
 * the native WebView `fetch` to route through the native HTTP stack. That
 * bypasses WebView CORS + preflight entirely while preserving the standard
 * `fetch()`/`Response` contract — so this wrapper stays a clean drop-in and call
 * sites keep using `.ok` / `.json()`. #66's server CORS remains the fallback for
 * the un-patched path.
 */

// Absolute origin the native shell talks to. Overridable for preview testing.
//
// MUST be the canonical, NON-redirecting host. Vercel redirects the apex
// `tuttohq.com` → `www.tuttohq.com` with a 307 on every path, including /api/*.
// From a WebView that turns each native /api call into a cross-origin redirect
// hop that WebKit answers by STRIPPING the Authorization header (and which
// CapacitorHttp's patched fetch can fail to follow) — the request dies on-device
// before it reaches the API ("The string did not match the expected pattern",
// no /api/projects in the Network tab). Hitting www directly avoids the hop.
// Prefer configuring NEXT_PUBLIC_API_BASE_URL so the host is config, not a
// literal; it must also resolve to the non-redirecting host.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://www.tuttohq.com"

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

// The bearer provider is injected by the native entry (which owns the supabase
// client) so api-client carries no hard dependency on a specific client/storage.
type TokenProvider = () => Promise<string | null>
let getAccessToken: TokenProvider = async () => null

export function setAccessTokenProvider(fn: TokenProvider): void {
  getAccessToken = fn
}

/**
 * Drop-in fetch for `/api` calls. `path` must be root-relative (e.g.
 * "/api/projects"); on native it is prefixed with API_BASE_URL.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const native = isNative()
  const url = native ? `${API_BASE_URL}${path}` : path

  const headers = new Headers(init.headers)
  if (native) {
    const token = await getAccessToken()
    if (token) headers.set("Authorization", `Bearer ${token}`)
  }

  return fetch(url, { ...init, headers })
}
