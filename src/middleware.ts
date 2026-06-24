import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

// Origins allowed to call /api cross-origin (ADR-010, Capacitor native).
// `capacitor://localhost` is the iOS native shell; the web origin is included
// per spec but is same-origin in practice, so it never triggers CORS handling.
// No wildcard, no credentials — native authenticates with bearer tokens, not
// cookies, so cross-origin requests never carry credentials.
const ALLOWED_ORIGINS = new Set(
  ["capacitor://localhost", process.env.NEXT_PUBLIC_APP_URL].filter(
    (o): o is string => Boolean(o),
  ),
)

function isAllowedOrigin(origin: string | null): origin is string {
  return !!origin && ALLOWED_ORIGINS.has(origin)
}

function applyCors(response: NextResponse, origin: string | null) {
  if (!isAllowedOrigin(origin)) return
  response.headers.set("Access-Control-Allow-Origin", origin)
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
  response.headers.set("Access-Control-Max-Age", "86400")
  response.headers.append("Vary", "Origin")
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const origin = request.headers.get("origin")
  const authHeader = request.headers.get("authorization")
  const isApi = path.startsWith("/api/")

  // CORS preflight from a native (Capacitor) caller — answer before any auth
  // logic so the cookie redirect can't 302 the preflight. No credentials.
  if (isApi && request.method === "OPTIONS" && isAllowedOrigin(origin)) {
    const preflight = new NextResponse(null, { status: 204 })
    applyCors(preflight, origin)
    return preflight
  }

  // Bearer-authed native /api calls bypass the cookie redirect. The shell loads
  // from capacitor://localhost, so the SSR cookie is never sent cross-origin —
  // let the route's own getUser() gate decide. Web page/cookie flow is untouched.
  if (isApi && authHeader?.startsWith("Bearer ")) {
    const passthrough = NextResponse.next()
    applyCors(passthrough, origin)
    return passthrough
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

  // Public paths accessible without auth. /invite/<token> is the accept
  // page; /api/invites/accept is the route that finalizes the link. Both
  // are token-gated, not session-gated — see accept_invite_link in
  // migrations.sql for the security model.
  const PUBLIC_PATHS = ["/", "/signup", "/login", "/articles", "/sitemap.xml", "/robots.txt"]
  const isPublic =
    PUBLIC_PATHS.includes(path) ||
    path.startsWith("/api/auth") ||
    path === "/api/signup" ||
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
