import type { NextConfig } from "next"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import withSerwistInit from "@serwist/next"

// ── PWA / offline shell (ADR-009 Phase 1, Step 1) ───────────────────────────
// Serwist in injectManifest mode: our custom SW (src/app/sw.ts) plus a
// BUILD-GENERATED precache manifest. The manifest must be build-generated
// because /_next/static hashes change every deploy — hand-maintaining the list
// is exactly what causes stale-shell white-screens.
//
// Per-build revision for non-hashed precache entries (the /offline document).
// On Vercel this is the commit SHA → one stable value per deploy; locally it
// falls back to the build timestamp. Either way it changes when the deploy
// changes, so /offline is re-precached and never goes stale.
const BUILD_REVISION = process.env.VERCEL_GIT_COMMIT_SHA ?? String(Date.now())

// @serwist/next precaches the build output (/_next/static/**) but NOT public/,
// so the manifest + icons are added explicitly here. They get content-hash
// revisions so they are only re-fetched at install when their bytes actually
// change (not on every deploy). /offline is a route, not a public file, so it
// rides the per-build revision above.
const fileRevision = (path: string) =>
  createHash("md5").update(readFileSync(path)).digest("hex")

const PUBLIC_ASSET_PRECACHE = [
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
].map((rel) => ({ url: `/${rel}`, revision: fileRevision(`public/${rel}`) }))

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // We register the SW ourselves (src/components/pwa-provider.tsx) to drive the
  // explicit "new version — reload" prompt, so disable Serwist's auto-register.
  register: false,
  // No SW in dev — avoids the classic "stale cache masks your edits" foot-gun.
  // Production builds (incl. Vercel preview/prod) get the SW.
  disable: process.env.NODE_ENV === "development",
  // Keep the precache lean: the offline SHELL only, never the heavy non-shell
  // lazy vendor bundles. This 0.8 MB cap drops exactly three chunks, all
  // dynamic-imported and none reachable from the dashboard/daily shell graph:
  //   • heic2any (~1.35 MB) — REQUIRED out for now. Offline HEIC is Step 2,
  //     gated on on-device SW→worker→WASM verification (ADR-009 §iOS #5).
  //   • unpdf (~1.6 MB)     — PDF parsing (spec-book / drawing split); needs an
  //     upload, so it is a network flow anyway.
  //   • exceljs (~0.93 MB)  — Excel import/export; network flow.
  // The largest genuine shell chunk is ~0.42 MB, so this cap has a wide margin
  // and cannot drop a shell chunk. Serwist logs every file excluded for
  // exceeding this limit at build time — check that log to confirm what dropped.
  // (A smaller precache also installs faster and is less eviction-prone on iOS.)
  maximumFileSizeToCacheInBytes: 800_000,
  // Precache what injectManifest can't see on its own:
  //   • /dashboard — the start_url client SHELL (statically prerendered, ○ in
  //     the build). This is the Step-1.1 deterministic offline shell: pinned
  //     with a per-build revision so an offline cold launch ALWAYS has the shell
  //     document, with NO dependence on the runtime NetworkFirst cache having
  //     captured it during a prior online session. The SW serves it as the
  //     navigation fallback for /dashboard (see sw.ts). Versioned by build →
  //     a redeploy re-precaches it, and the install-and-wait + reload prompt
  //     keeps a stale shell from ever activating against new chunks.
  //   • /offline — the dead-zone fallback document for never-primed routes.
  //   • /manifest.webmanifest + icons (content-hashed) — brand/install assets.
  additionalPrecacheEntries: [
    { url: "/dashboard", revision: BUILD_REVISION },
    { url: "/offline", revision: BUILD_REVISION },
    { url: "/manifest.webmanifest", revision: BUILD_REVISION },
    ...PUBLIC_ASSET_PRECACHE,
  ],
})

const config: NextConfig = {
  // sharp ships a native binary — keep it external so server bundles load it
  // at runtime instead of trying to bundle it (used by the photo-resize step
  // in PDF generation).
  serverExternalPackages: ["sharp"],

  // The generated documents embed Source Serif 4 from src/lib/fonts/*.ttf via fs
  // at runtime (shared PdfDoc builder). Force-include those bytes in the
  // serverless functions that render them — the nft tracer doesn't follow the
  // runtime path.join read on its own.
  outputFileTracingIncludes: {
    "/api/change-orders/pco/**": ["./src/lib/fonts/*.ttf"],
    "/api/purchase-orders/**": ["./src/lib/fonts/*.ttf"],
  },
}

export default withSerwist(config)
