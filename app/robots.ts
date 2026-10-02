import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  if (process.env.CRAZYLOOPS_DEPLOYMENT_ROLE === "staging") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/settings", "/api/"] },
    sitemap: "https://www.crazy-loops.com/sitemap.xml",
    host: "https://www.crazy-loops.com",
  };
}
