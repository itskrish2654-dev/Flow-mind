import "server-only";

import { headers } from "next/headers";

export async function getClientIp(): Promise<string> {
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwarded ||
    requestHeaders.get("x-real-ip")?.trim() ||
    requestHeaders.get("x-vercel-forwarded-for")?.trim() ||
    "unknown"
  ).slice(0, 80);
}
