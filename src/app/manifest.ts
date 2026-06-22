import type { MetadataRoute } from "next"

// Web app manifest (ADR-009 Phase 1). Next serves this at /manifest.webmanifest
// and auto-injects <link rel="manifest"> into <head>.
//
// start_url is the dashboard entry. It must be offline-resolvable: the SW's
// navigation NetworkFirst rule caches it on the first online visit, so a PWA
// cold launch in airplane mode serves the cached shell (and the navigation
// fallback covers a never-primed launch with /offline).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "TuttoHQ",
    short_name: "TuttoHQ",
    description:
      "Construction submittals, RFIs, change orders, drawings, and field daily reports — usable in the field, even offline.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Navy brand surface — matches the app shell rail and the icon background,
    // so the iOS/Android splash reads as one cohesive dark surface.
    background_color: "#0A1628",
    theme_color: "#0A1628",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
