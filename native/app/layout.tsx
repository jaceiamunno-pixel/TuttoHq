import type { ReactNode } from "react"

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
