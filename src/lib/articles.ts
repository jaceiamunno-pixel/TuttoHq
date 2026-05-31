import { promises as fs } from "fs"
import path from "path"
import matter from "gray-matter"
import { remark } from "remark"
import remarkGfm from "remark-gfm"
import remarkHtml from "remark-html"

// ─── Marketing articles ────────────────────────────────────────────────────
// MDX files in /content/articles are read at build time and rendered as
// static HTML so the pages serve as plain crawlable documents for AEO/SEO.
// Body is plain Markdown; the .mdx extension is convention, leaving room
// to swap in proper MDX with JSX components later if we ever need it.

export interface ArticleFrontmatter {
  title: string
  slug: string
  description: string
  publishedDate: string
  updatedDate?: string
  author: string
}

export interface ArticleMeta extends ArticleFrontmatter {
  filePath: string
}

export interface Article extends ArticleMeta {
  contentHtml: string
}

const ARTICLES_DIR = path.join(process.cwd(), "content", "articles")

async function readArticleFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(ARTICLES_DIR)
    return entries.filter(f => f.endsWith(".mdx") || f.endsWith(".md"))
  } catch {
    return []
  }
}

function parseFrontmatter(raw: string, filePath: string): { fm: ArticleFrontmatter; body: string } {
  const parsed = matter(raw)
  const data = parsed.data as Partial<ArticleFrontmatter>
  if (!data.title || !data.slug || !data.description || !data.publishedDate || !data.author) {
    throw new Error(
      `Article at ${filePath} is missing required frontmatter ` +
      `(title, slug, description, publishedDate, author).`,
    )
  }
  return {
    fm: {
      title: data.title,
      slug: data.slug,
      description: data.description,
      publishedDate: data.publishedDate,
      updatedDate: data.updatedDate,
      author: data.author,
    },
    body: parsed.content,
  }
}

export async function listArticles(): Promise<ArticleMeta[]> {
  const files = await readArticleFiles()
  const all = await Promise.all(files.map(async (file) => {
    const filePath = path.join(ARTICLES_DIR, file)
    const raw = await fs.readFile(filePath, "utf8")
    const { fm } = parseFrontmatter(raw, filePath)
    return { ...fm, filePath }
  }))
  return all.sort((a, b) =>
    new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime())
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const files = await readArticleFiles()
  for (const file of files) {
    const filePath = path.join(ARTICLES_DIR, file)
    const raw = await fs.readFile(filePath, "utf8")
    const { fm, body } = parseFrontmatter(raw, filePath)
    if (fm.slug !== slug) continue
    const processed = await remark().use(remarkGfm).use(remarkHtml).process(body)
    return { ...fm, filePath, contentHtml: String(processed) }
  }
  return null
}

export function articleUrl(slug: string): string {
  return `/articles/${slug}`
}

export function absoluteArticleUrl(slug: string): string {
  return `https://tuttohq.com/articles/${slug}`
}

export function formatPublishedDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}
