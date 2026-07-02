import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { checkAuthLimit, checkWriteLimit } from "@/lib/ratelimit"

// Origins permitted to make cross-origin /api calls (ADR-010 Capacitor seam).
// The native shell runs at capacitor://localhost; the web app at its own URL.
// No wildcard and no Access-Control-Allow-Credentials — bearer-token auth only,
// never cookies, on the cross-origin path.
const ALLOWED_ORIGINS = new Set(
  ["capacitor://localhost", process.env.NEXT_PUBLIC_APP_URL].filter(Boolean) as string[],
)

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, PUT, DELETE, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    headers["Access-Control-Max-Age"] = "86400"
  }
  return headers
}

// ── Tier 1 rate limiting (abuse protection) ──────────────────────────────────
// Enforced here in middleware, FAIL OPEN (see src/lib/ratelimit.ts). The auth
// surface is keyed by client IP (pre-auth, brute-force/credential-stuffing
// protection); authenticated write methods are keyed by user id. Tier 2 (the
// expensive Claude/PDF surface) is enforced per-route and is intentionally NOT
// here — it fails closed, which would be wrong for general traffic.
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"])

function isAuthSurface(path: string): boolean {
  // The login form talks straight to Supabase GoTrue (not through our API), so
  // the rate-limitable auth surface is our signup route + the OAuth routes.
  // /api/demo creates an auth user on every unauthenticated POST, so it gets the
  // same IP-keyed Tier-1 throttle to blunt bot-driven demo-account spam.
  return path.startsWith("/api/auth/") || path === "/api/signup" || path === "/api/demo"
}

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim()
  return request.headers.get("x-real-ip") ?? "unknown"
}

// Post-auth Tier-1 key. We key by USER ID, not company_id: resolving the company
// at the middleware layer would cost a DB round-trip on every write AND the
// native bearer branch returns before any session is built. user id is available
// cleanly on both paths — getUser() on the cookie path, the JWT `sub` claim on
// the bearer path (decoded here for keying only; the route still does the real
// getUser() validation). A forged token only lets an attacker dodge their OWN
// write limit, and such requests still 401 at the route — so it is harmless.
function userIdFromBearer(authHeader: string): string | null {
  try {
    const payload = authHeader.slice("Bearer ".length).split(".")[1]
    if (!payload) return null
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const sub = JSON.parse(atob(padded))?.sub
    return typeof sub === "string" && sub ? sub : null
  } catch {
    return null
  }
}

function rateLimited(retryAfter: number, origin: string | null): NextResponse {
  const res = NextResponse.json(
    { error: "Too many requests. Please slow down and try again." },
    { status: 429 },
  )
  res.headers.set("Retry-After", String(retryAfter))
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v)
  return res
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const origin = request.headers.get("origin")
  const isApi = path.startsWith("/api/")
  const isWrite = WRITE_METHODS.has(request.method)
  const authSurface = isApi && isAuthSurface(path)

  // ADR-010 (Capacitor): handle cross-origin /api traffic BEFORE any
  // cookie-session work or auth redirect.
  if (isApi) {
    // CORS preflight from an allowed origin → answer immediately, no auth.
    if (request.method === "OPTIONS" && origin && ALLOWED_ORIGINS.has(origin)) {
      return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
    }

    // TIER 1 (auth surface) — key by IP, regardless of method or auth path.
    if (authSurface) {
      const { blocked, retryAfter } = await checkAuthLimit(clientIp(request))
      if (blocked) return rateLimited(retryAfter, origin)
    }

    // Bearer-authenticated native call: let it through to the route (which runs
    // its own getUser() 401 gate) instead of 307-ing it to /login. Attach CORS
    // so the native WebView can read the response.
    const authHeader = request.headers.get("authorization")
    if (authHeader?.startsWith("Bearer ")) {
      // TIER 1 (write methods) — key by JWT sub, falling back to IP.
      if (isWrite && !authSurface) {
        const { blocked, retryAfter } = await checkWriteLimit(
          userIdFromBearer(authHeader) ?? `ip:${clientIp(request)}`,
        )
        if (blocked) return rateLimited(retryAfter, origin)
      }
      const res = NextResponse.next({ request })
      for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v)
      return res
    }
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // Refresh session — must call getUser() not getSession()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // TIER 1 (write methods) on the cookie path — key by authed user id. Runs
  // after getUser() so unauthenticated writes fall through to the /login
  // redirect below (they can't do anything, so they need no limit). FAIL OPEN.
  if (isApi && isWrite && !authSurface && user) {
    const { blocked, retryAfter } = await checkWriteLimit(user.id)
    if (blocked) return rateLimited(retryAfter, origin)
  }

  // Public paths accessible without auth. /invite/<token> is the accept
  // page; /api/invites/accept is the route that finalizes the link. Both
  // are token-gated, not session-gated — see accept_invite_link in
  // migrations.sql for the security model.
const PUBLIC_PATHS = ["/", "/signup", "/login", "/demo", "/privacy", "/terms", "/articles", "/sitemap.xml", "/robots.txt"]
  const isPublic =
    PUBLIC_PATHS.includes(path) ||
    path.startsWith("/api/auth") ||
    path === "/api/signup" ||
    path === "/api/demo" ||
    path.startsWith("/invite/") ||
    path === "/api/invites/accept" ||
    path.startsWith("/articles/")

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    return NextResponse.redirect(url)
  }

  // Authenticated users get sent to /dashboard from auth/landing pages
  if (user && (path === "/login" || path === "/")) {
    const url = request.nextUrl.clone()
    url.pathname = "/dashboard"
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/gmail-intake|api/cron).*)"],
}
