import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
}

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "TuttoHQ — Construction Submittal & Document Management Software | Procore Alternative",
  description: "Manage submittals, RFIs, change orders, punch lists, and daily reports in one platform. AI-powered, Gmail-integrated, and 75% cheaper than Procore. Free 14-day trial.",
  keywords: "construction submittal management software, submittal tracking software, RFI tracking construction, change order management software, Procore alternative, construction document management",
  metadataBase: new URL("https://tuttohq.com"),
  alternates: { canonical: "https://tuttohq.com" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "TuttoHQ — Construction Document Management Made Simple",
    description: "The affordable alternative to Procore for general contractors. Auto-ingest submittals from Gmail, track RFIs and change orders, generate branded PDFs. $199/month unlimited users.",
    url: "https://tuttohq.com",
    siteName: "TuttoHQ",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TuttoHQ — Construction Document Management Made Simple",
    description: "The affordable alternative to Procore for general contractors. $199/month, unlimited users, set up in under 10 minutes.",
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-[#F4F5F7] text-[#0F172A] antialiased`}>
        {children}
      </body>
    </html>
  )
}
