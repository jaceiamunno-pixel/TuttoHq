import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

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

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const origin = request.headers.get("origin")
  const isApi = path.startsWith("/api/")

  // ADR-010 (Capacitor): handle cross-origin /api traffic BEFORE any
  // cookie-session work or auth redirect.
  if (isApi) {
    // CORS preflight from an allowed origin → answer immediately, no auth.
    if (request.method === "OPTIONS" && origin && ALLOWED_ORIGINS.has(origin)) {
      return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
    }

    // Bearer-authenticated native call: let it through to the route (which runs
    // its own getUser() 401 gate) instead of 307-ing it to /login. Attach CORS
    // so the native WebView can read the response.
    const authHeader = request.headers.get("authorization")
    if (authHeader?.startsWith("Bearer ")) {
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
