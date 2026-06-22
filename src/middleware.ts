import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function middleware(request: NextRequest) {
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

  const path = request.nextUrl.pathname

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
  // PWA surfaces are excluded so the auth check never rewrites them to a /login
  // redirect (ADR-009 Phase 1): the service worker script (sw.js), the web
  // manifest, the icons, and the static offline-fallback document must all be
  // fetchable regardless of session state. The SW itself answers protected
  // navigations from cache when offline, so middleware getUser() never runs in
  // a dead zone.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/gmail-intake|api/cron|sw.js|manifest.webmanifest|icons|offline).*)",
  ],
}
