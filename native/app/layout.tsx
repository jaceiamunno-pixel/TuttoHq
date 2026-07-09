import type { ReactNode } from "react"

/**
 * BUILD-TIME guard for the ADR-010 native export.
 *
 * This root layout is a server component, so this module executes during
 * `next build native`'s prerender pass (in Node, with the repo-root .env.local
 * loaded by the loadEnvConfig() call in native/next.config.ts) — NOT in the
 * on-device WebView. Throwing here fails the BUILD if the public Supabase vars
 * didn't inline, so a broken env-load can never ship a green bundle that boots
 * then throws "supabaseUrl is required" on the device. A guard placed in client
 * code would only fire in the WebView, which reproduces the original bug instead
 * of catching it at build time.
 */
if (
  !process.env.NEXT_PUBLIC_SUPABASE_URL ||
  !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
) {
  throw new Error(
    "native build: NEXT_PUBLIC_SUPABASE_* missing — check loadEnvConfig() in native/next.config.ts",
  )
}

export const metadata = {
  title: "TuttoHQ",
  description: "TuttoHQ native shell (ADR-010)",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#F4F5F7",
          color: "#0F172A",
        }}
      >
        {children}
      </body>
    </html>
  )
}
