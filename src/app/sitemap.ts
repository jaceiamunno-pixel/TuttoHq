import type { MetadataRoute } from "next"
import { listArticles } from "@/lib/articles"

const BASE_URL = "https://tuttohq.com"

export const dynamic = "force-static"

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const articles = await listArticles()

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/articles`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
  ]

  const articleRoutes: MetadataRoute.Sitemap = articles.map((a) => ({
    url: `${BASE_URL}/articles/${a.slug}`,
    lastModified: new Date(a.updatedDate ?? a.publishedDate),
    changeFrequency: "monthly",
    priority: 0.7,
  }))

  return [...staticRoutes, ...articleRoutes]
}
