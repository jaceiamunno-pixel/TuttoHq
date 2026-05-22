import type { NextConfig } from "next"

const config: NextConfig = {
  // sharp ships a native binary — keep it external so server bundles load it
  // at runtime instead of trying to bundle it (used by the photo-resize step
  // in PDF generation).
  serverExternalPackages: ["sharp"],
}

export default config
