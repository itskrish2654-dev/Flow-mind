import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CrazyLoops",
    short_name: "CrazyLoops",
    description: "Build reliable AI-powered workflows from plain English.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f6f1",
    theme_color: "#f4d63f",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
