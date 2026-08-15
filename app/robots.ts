import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/settings", "/api/"] },
    sitemap: "https://www.crazy-loops.com/sitemap.xml",
    host: "https://www.crazy-loops.com",
  };
}
