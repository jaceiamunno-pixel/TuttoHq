import type { NextConfig } from "next"

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
