import type { NextConfig } from "next"

const config: NextConfig = {
  // Tree-shake the icon/motion barrels: only the components actually imported
  // ship to the client instead of the whole package. Pure build-time transform.
  experimental: {
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },

  // sharp ships a native binary, and mupdf loads a sibling .wasm via
  // import.meta.url — keep both external so server bundles load them from
  // node_modules at runtime instead of webpack rewriting the asset path.
  // (mupdf is the OCG-layer fallback extractor in the schedule-import parser.)
  serverExternalPackages: ["sharp", "mupdf"],

  // The generated documents embed Source Serif 4 from src/lib/fonts/*.ttf via fs
  // at runtime (shared PdfDoc builder). Force-include those bytes in the
  // serverless functions that render them — the nft tracer doesn't follow the
  // runtime path.join read on its own. Same reason for the mupdf .wasm: the
  // schedule-import parser reads it via import.meta.url, which nft won't trace.
  outputFileTracingIncludes: {
    "/api/change-orders/pco/**": ["./src/lib/fonts/*.ttf"],
    "/api/purchase-orders/**": ["./src/lib/fonts/*.ttf"],
    "/api/schedule-import/parse/**": ["./node_modules/mupdf/dist/mupdf-wasm.wasm"],
  },
}

export default config
