import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Submittal Library — THP Construction",
  description: "Search and access project submittal documents organized by CSI MasterFormat",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-white text-[#37352f] antialiased`}>
        {children}
      </body>
    </html>
  )
}
