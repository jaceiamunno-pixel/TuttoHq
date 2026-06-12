import type { NextConfig } from "next"

const config: NextConfig = {
  // sharp ships a native binary — keep it external so server bundles load it
  // at runtime instead of trying to bundle it (used by the photo-resize step
  // in PDF generation).
  serverExternalPackages: ["sharp"],

  // The PCO documents embed Source Serif 4 from src/lib/fonts/*.ttf via fs at
  // runtime. Force-include those bytes in the serverless functions that render
  // them (the nft tracer doesn't follow the runtime path.join read on its own).
  outputFileTracingIncludes: {
    "/api/change-orders/pco/**": ["./src/lib/fonts/*.ttf"],
  },
}

export default config
