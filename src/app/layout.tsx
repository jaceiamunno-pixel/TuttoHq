import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { KeyboardNavProvider } from "@/components/keyboard-nav"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
}

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "TuttoHQ — Construction Submittal & Document Management Software for General Contractors",
  description: "AI-classified submittals, spec-book ingestion, and a markup-ready drawing log — plus RFIs, change orders, and purchase orders in one platform. Built for general contractors. Free 14-day trial.",
  keywords: "construction submittal management software, submittal tracking software, spec book ingestion, construction drawing log software, drawing markup software, RFI tracking construction, change order management software, purchase order tracking construction, construction document management",
  metadataBase: new URL("https://tuttohq.com"),
  alternates: { canonical: "https://tuttohq.com" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "TuttoHQ — Construction Document Management Made Simple",
    description: "The affordable alternative to heavyweight enterprise construction platforms. AI-classified submittals, spec-book ingestion, a markup-ready drawing log, plus RFIs, change orders, and POs. Built for GCs, not enterprise IT.",
    url: "https://tuttohq.com",
    siteName: "TuttoHQ",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TuttoHQ — Construction Document Management Made Simple",
    description: "AI-classified submittals, spec-book ingestion, and a markup-ready drawing log, plus RFIs, COs, and POs. The affordable alternative to enterprise construction platforms — unlimited users, set up in under 10 minutes.",
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-[#F4F5F7] text-[#0F172A] antialiased`}>
        {/* Global arrow-key navigation layer. Mounted once at the app shell so a
            single document keydown listener serves every route; it is inert on
            routes that register no regions. */}
        <KeyboardNavProvider>
          {children}
        </KeyboardNavProvider>
      </body>
    </html>
  )
}
