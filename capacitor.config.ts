import type { CapacitorConfig } from "@capacitor/cli"

/**
 * Capacitor config for the TuttoHQ native shell (ADR-010).
 *
 * BUNDLED-STATIC shell: the HTML/JS/CSS ship on-device via `webDir`, which
 * points at the native Next static export (`npm run build:native` → native/out).
 * We deliberately do NOT set `server.url` to a remote site — that remote-URL
 * pattern reintroduces the "can't open the app offline" wall that ADR-010 exists
 * to kill. Only `/api` is remote; the shell itself is local.
 */
const config: CapacitorConfig = {
  appId: "com.tuttohq.app",
  appName: "TuttoHQ",
  webDir: "native/out",
  ios: {
    contentInset: "always",
  },
  plugins: {
    // Route native fetch() through the native HTTP stack: bypasses WebView CORS
    // + preflight latency while keeping the standard fetch()/Response contract,
    // so src/lib/api-client.ts stays a clean drop-in.
    CapacitorHttp: {
      enabled: true,
    },
  },
}

export default config
