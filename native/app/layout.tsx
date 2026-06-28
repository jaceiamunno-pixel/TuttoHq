import type { ReactNode } from "react"
import DiagErrorOverlay from "./_diag-error-overlay"

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
        {/* TEMPORARY native-debug error surface — remove after diagnosing. */}
        <DiagErrorOverlay />
        {children}
      </body>
    </html>
  )
}
