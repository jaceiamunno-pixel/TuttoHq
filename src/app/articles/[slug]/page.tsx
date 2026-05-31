import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { FileText } from "lucide-react"
import {
  getArticleBySlug,
  listArticles,
  formatPublishedDate,
  absoluteArticleUrl,
} from "@/lib/articles"

export const dynamic = "force-static"

export async function generateStaticParams() {
  const articles = await listArticles()
  return articles.map((a) => ({ slug: a.slug }))
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  if (!article) return {}
  const url = absoluteArticleUrl(article.slug)
  return {
    title: `${article.title} — TuttoHQ`,
    description: article.description,
    alternates: { canonical: url },
    openGraph: {
      title: article.title,
      description: article.description,
      url,
      siteName: "TuttoHQ",
      type: "article",
      publishedTime: article.publishedDate,
      modifiedTime: article.updatedDate ?? article.publishedDate,
      authors: [article.author],
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
    },
  }
}

export default async function ArticlePage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  if (!article) notFound()

  const url = absoluteArticleUrl(article.slug)
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.description,
    datePublished: article.publishedDate,
    dateModified: article.updatedDate ?? article.publishedDate,
    author: { "@type": "Person", name: article.author },
    publisher: {
      "@type": "Organization",
      name: "TuttoHQ",
      url: "https://tuttohq.com",
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />

      <div className="min-h-screen bg-[#060b18] text-[#e8edf5]">
        <header className="border-b border-[#1e2d4a]/60 bg-[#060b18]/90 backdrop-blur-xl">
          <nav className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[#7B9BB5] flex items-center justify-center flex-shrink-0">
                <FileText className="w-4 h-4 text-white" />
              </div>
              <span className="text-[16px] font-bold text-[#f0f4ff] tracking-tight">TuttoHQ</span>
            </Link>
            <div className="flex items-center gap-5">
              <Link
                href="/articles"
                className="hidden sm:inline text-[13px] text-[#8b9ab5] hover:text-[#e8edf5] transition-colors"
              >
                All Articles
              </Link>
              <Link
                href="/signup"
                className="text-[13px] font-bold text-white px-4 py-2 rounded-lg bg-[#7B9BB5] hover:bg-[#6A8AA4] transition-colors"
              >
                Start Free Trial
              </Link>
            </div>
          </nav>
        </header>

        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-20">
          <Link
            href="/articles"
            className="inline-flex items-center gap-1.5 text-[13px] text-[#7B9BB5] hover:text-[#a4bccf] transition-colors mb-8"
          >
            ← All articles
          </Link>

          <article>
            <header className="mb-10 sm:mb-12 pb-8 border-b border-[#1e2d4a]/60">
              <h1 className="text-3xl sm:text-4xl lg:text-[44px] font-extrabold text-[#f0f4ff] tracking-tight leading-tight mb-5">
                {article.title}
              </h1>
              <p className="text-[17px] text-[#8b9ab5] leading-relaxed mb-6">
                {article.description}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[#4f617a]">
                <span className="font-semibold">{article.author}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={article.publishedDate}>
                  {formatPublishedDate(article.publishedDate)}
                </time>
                {article.updatedDate && article.updatedDate !== article.publishedDate && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Updated {formatPublishedDate(article.updatedDate)}</span>
                  </>
                )}
              </div>
            </header>

            <div
              className="article-prose"
              dangerouslySetInnerHTML={{ __html: article.contentHtml }}
            />
          </article>

          <div className="mt-16 pt-10 border-t border-[#1e2d4a]/60">
            <div className="rounded-2xl border border-[#7B9BB5]/30 bg-[#0c1526] p-7 sm:p-9 text-center">
              <h2 className="text-[20px] sm:text-[22px] font-extrabold text-[#f0f4ff] tracking-tight mb-3">
                Stop managing submittals in email
              </h2>
              <p className="text-[14px] text-[#8b9ab5] mb-6 max-w-md mx-auto leading-relaxed">
                TuttoHQ auto-ingests submittals from Gmail, classifies them by CSI
                division with AI, and generates branded PDFs in one click.
              </p>
              <Link
                href="/signup"
                className="inline-block px-6 py-3 rounded-xl bg-[#7B9BB5] hover:bg-[#6A8AA4] text-white text-[14px] font-bold transition-all shadow-lg shadow-[#7B9BB5]/25"
              >
                Start your free 14-day trial
              </Link>
            </div>
          </div>
        </main>

        <footer className="border-t border-[#1e2d4a]/40 bg-[#060b18] py-10 mt-12">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p className="text-[12px] text-[#3d506a]">
              © 2026 TuttoHQ. <Link href="/" className="hover:text-[#8b9ab5] transition-colors">Back to tuttohq.com</Link>
            </p>
          </div>
        </footer>
      </div>
    </>
  )
}
