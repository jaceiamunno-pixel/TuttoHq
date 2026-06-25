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
 * Auth-transport seam for the Capacitor native shell (ADR-010).
 *
 * Native clients have no cookie jar, so they send the user's Supabase session
 * as an `Authorization: Bearer <access_token>` header. When that header is
 * present we build a plain supabase-js client whose every request carries the
 * user's JWT — `getUser()` then validates that token and RLS resolves
 * `auth.uid()` / `get_my_company_id()` exactly as it does for the cookie path.
 *
 * No bearer header → fall back to the unchanged cookie-based `createClient()`
 * so online web auth is byte-identical to before.
 */
export async function createClientFromRequest(req: Request) {
  const authHeader = req.headers.get("authorization")

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length)
    return createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: { Authorization: `Bearer ${token}` },
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    )
  }

  return createClient()
}
