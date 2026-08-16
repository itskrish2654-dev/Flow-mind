import type { NextConfig } from "next";

const supabaseOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : "";
  } catch {
    return "";
  }
})();
const supabaseWebSocketOrigin = supabaseOrigin.replace(/^https:/, "wss:");
const developmentScripts = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${developmentScripts} https://challenges.cloudflare.com https://apis.google.com https://accounts.google.com`,
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://ssl.gstatic.com https://www.gstatic.com",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseWebSocketOrigin} https://challenges.cloudflare.com https://accounts.google.com https://apis.google.com https://www.googleapis.com https://oauth2.googleapis.com`.replace(/\s+/g, " ").trim(),
  "frame-src https://challenges.cloudflare.com https://accounts.google.com https://docs.google.com https://drive.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  ...(process.env.NODE_ENV === "production"
    ? ["upgrade-insecure-requests", "block-all-mixed-content"]
    : []),
].join("; ");

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@fontsource/noto-sans/files/*.woff",
      "./node_modules/@fontsource/noto-sans-devanagari/files/*.woff",
      "./node_modules/@fontsource/noto-sans-jp/files/*.woff",
      "./node_modules/@fontsource/noto-sans-jp/unicode.json",
      "./node_modules/pdfkit/js/data/*.afm",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
