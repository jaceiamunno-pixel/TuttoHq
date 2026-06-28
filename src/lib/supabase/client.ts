import { createBrowserClient } from "@supabase/ssr"
import { isNative } from "@/lib/api-client"
import { getNativeSupabaseClient } from "@/lib/supabase/native"

export function createClient() {
  // Native (Capacitor) WebView can't use @supabase/ssr's createBrowserClient:
  // its cookie/URL handling throws ("the string did not match the expected
  // pattern") under capacitor://localhost. Route native callers to the
  // @capacitor/preferences-backed client instead — same SupabaseClient surface
  // (.auth / .from), so the 9 existing callers need no changes. See ADR-010.
  if (isNative()) return getNativeSupabaseClient()
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
