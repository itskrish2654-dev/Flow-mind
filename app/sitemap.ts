import type { MetadataRoute } from "next";

const publicRoutes = ["", "/privacy", "/terms", "/security", "/data-use", "/support"];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.map((route) => ({
    url: `https://crazyloops.com${route || "/"}`,
    lastModified: new Date("2026-08-14T00:00:00.000Z"),
    changeFrequency: route ? "monthly" : "weekly",
    priority: route ? 0.6 : 1,
  }));
}
