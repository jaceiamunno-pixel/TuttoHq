import type { Metadata } from "next"
import Link from "next/link"
import { FileText } from "lucide-react"
import { listArticles, formatPublishedDate } from "@/lib/articles"

export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "Articles — TuttoHQ",
  description:
    "Field notes on construction submittal management, RFIs, change orders, and how general contractors keep their document chaos under control.",
  alternates: { canonical: "https://tuttohq.com/articles" },
  openGraph: {
    title: "Articles — TuttoHQ",
    description:
      "Field notes on construction submittal management, RFIs, change orders, and how general contractors keep their document chaos under control.",
    url: "https://tuttohq.com/articles",
    siteName: "TuttoHQ",
    type: "website",
  },
}

export default async function ArticlesIndexPage() {
  const articles = await listArticles()

  return (
    <div className="min-h-screen bg-[#060b18] text-[#e8edf5]">
      <header className="border-b border-[#1e2d4a]/60 bg-[#060b18]/90 backdrop-blur-xl">
        <nav className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#7B9BB5] flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-white" />
            </div>
            <span className="text-[16px] font-bold text-[#f0f4ff] tracking-tight">TuttoHQ</span>
          </Link>
          <Link
            href="/signup"
            className="text-[13px] font-bold text-white px-4 py-2 rounded-lg bg-[#7B9BB5] hover:bg-[#6A8AA4] transition-colors"
          >
            Start Free Trial
          </Link>
        </nav>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
        <div className="mb-12 sm:mb-16">
          <p className="text-[13px] font-bold text-[#7B9BB5] uppercase tracking-widest mb-3">
            Articles
          </p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight leading-tight mb-4">
            Field notes on construction document management
          </h1>
          <p className="text-[17px] text-[#8b9ab5] leading-relaxed">
            Practical writing for general contractors — submittal workflow, RFI tracking,
            change orders, and the operational habits that separate organized teams from
            the rest.
          </p>
        </div>

        {articles.length === 0 ? (
          <p className="text-[15px] text-[#4f617a]">No articles yet. Check back soon.</p>
        ) : (
          <ul className="divide-y divide-[#1e2d4a]/60 border-y border-[#1e2d4a]/60">
            {articles.map((a) => (
              <li key={a.slug}>
                <Link
                  href={`/articles/${a.slug}`}
                  className="group block py-7 sm:py-8 transition-colors"
                >
                  <time
                    dateTime={a.publishedDate}
                    className="text-[12px] font-semibold text-[#4f617a] uppercase tracking-wider"
                  >
                    {formatPublishedDate(a.publishedDate)}
                  </time>
                  <h2 className="mt-2 text-[20px] sm:text-[22px] font-bold text-[#e8edf5] tracking-tight group-hover:text-[#7B9BB5] transition-colors">
                    {a.title}
                  </h2>
                  <p className="mt-2 text-[15px] text-[#8b9ab5] leading-relaxed">
                    {a.description}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="border-t border-[#1e2d4a]/40 bg-[#060b18] py-10 mt-12">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-[12px] text-[#3d506a]">
            © 2026 TuttoHQ. <Link href="/" className="hover:text-[#8b9ab5] transition-colors">Back to tuttohq.com</Link>
          </p>
        </div>
      </footer>
    </div>
  )
}
