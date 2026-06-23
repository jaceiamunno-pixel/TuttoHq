import { createServerClient } from "@supabase/ssr"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { cookies } from "next/headers"

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Called from a Server Component — session refresh handled by middleware
          }
        },
      },
    },
  )
}

/**
 * Request-aware Supabase client for API routes (ADR-010, Capacitor native).
 *
 * The web app authenticates with the SSR auth cookie. A Capacitor native shell
 * loads from `capacitor://localhost` and calls `/api` cross-origin, so the
 * cookie is never sent. Native clients instead send the user's Supabase access
 * token in the `Authorization: Bearer <jwt>` header.
 *
 * When a bearer token is present, this builds a token-scoped client that
 * forwards the user's JWT (not the anon key) on every PostgREST/Storage request
 * — so `supabase.auth.getUser()` validates the token AND RLS resolves
 * `auth.uid()` / `get_my_company_id()` exactly as the cookie path does.
 *
 * When no bearer token is present, it returns the existing cookie-based
 * `createClient()` unchanged — web behavior is byte-identical.
 */
export async function createClientFromRequest(req: Request) {
  const authHeader = req.headers.get("authorization")

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim()
    return createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        // Forward the caller's JWT on auth, PostgREST, and Storage requests.
        // apikey stays the anon key; this Authorization wins over it, so RLS
        // sees the real user. With a custom Authorization header set,
        // getUser() (no arg) validates this token instead of a cookie session.
        global: { headers: { Authorization: `Bearer ${token}` } },
        // Per-request server client: no session persistence or refresh.
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    )
  }

  // No bearer token → unchanged cookie-based client (web path).
  return createClient()
}
