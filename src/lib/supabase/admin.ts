import { createClient } from "@supabase/supabase-js"

// Service-role client — bypasses RLS. Always verify user auth first before using this.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}
