import type { NextConfig } from "next"
import { loadEnvConfig } from "@next/env"

/**
 * ENV FIX (ADR-010): `next build native` makes native/ the project dir, so
 * Next's own env loader looks in native/.env* — which don't exist — and inlines
 * every NEXT_PUBLIC_* (Supabase URL/anon key, API base) as `undefined`. The
 * build goes GREEN, then the app boots and throws "supabaseUrl is required".
 *
 * Next has NO `envDir` option (that's a Vite feature) — the supported fix is to
 * load the repo-root .env* ourselves at config-eval time, which runs before
 * webpack inlines NEXT_PUBLIC_* during compile. `forceReload: true` makes this
 * authoritative even if Next already cached an (empty) load from native/.
 * process.cwd() is the repo root because build:native runs `next build native`
 * from there. Do NOT add a native/.env file to work around this — that just
 * reintroduces the drift this fixes.
 */
loadEnvConfig(
  process.cwd(),
  process.env.NODE_ENV === "development",
  undefined,
  true,
)

/**
 * Dedicated static-export target for the Capacitor native shell.
 *
 * This is a SEPARATE build tree from the root web app, built via its own
 * invocation: `next build native` (see root package.json `build:native`).
 * `output: export` is global per build, and the root web app can't be statically
 * exported — it has ~50 API route handlers and dynamic routes (/projects/[id],
 * /invite/[token]) that have no static form. This minimal tree contains only
 * client pages, so it exports cleanly. The root web/Vercel build is untouched.
 */
const config: NextConfig = {
  output: "export",
  distDir: "out",
  images: { unoptimized: true },
}

export default config
