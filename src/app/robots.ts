import type { MetadataRoute } from "next"

const BASE_URL = "https://tuttohq.com"

export const dynamic = "force-static"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/articles", "/articles/"],
        disallow: ["/api/", "/dashboard", "/settings", "/login", "/signup", "/invite/"],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}
