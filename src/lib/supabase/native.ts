import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { Preferences } from "@capacitor/preferences"

/**
 * Native (Capacitor) Supabase client for the ADR-010 shell.
 *
 * Unlike the web client (`@supabase/ssr` createBrowserClient, cookie-backed),
 * the native client persists its session through @capacitor/preferences. On iOS
 * that is a native key/value store (UserDefaults-backed) that survives app-kill
 * and WKWebView cache eviction — THIS is what lets the app reopen offline with a
 * live session, the whole point of ADR-010. (@capacitor/preferences also ships a
 * web implementation, so this adapter round-trips in tests and on web too.)
 *
 * supabase-js GoTrue accepts any storage exposing get/set/removeItem; async
 * return values are awaited internally, so the Preferences-backed adapter slots
 * straight in.
 */
export const preferencesStorage = {
  async getItem(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key })
    return value
  },
  async setItem(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value })
  },
  async removeItem(key: string): Promise<void> {
    await Preferences.remove({ key })
  },
}

let client: SupabaseClient | null = null

/**
 * Lazily build (and memoize) the native client. Construction is deferred to
 * first call so the static-export prerender never evaluates it with undefined
 * env vars — only the on-device runtime / client effects touch it.
 */
export function getNativeSupabaseClient(): SupabaseClient {
  if (client) return client
  // DIAGNOSTIC: fail loudly with the actual env state if the static-export
  // bundle didn't receive the public env vars. supabase-js otherwise throws a
  // cryptic "the string did not match the expected pattern" while parsing an
  // empty URL; this surfaces whether the vars made it into the native bundle.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("native supabase env missing: url=" + JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_URL) + " anonKeyPresent=" + !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  }
  client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        storage: preferencesStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    },
  )
  return client
}
