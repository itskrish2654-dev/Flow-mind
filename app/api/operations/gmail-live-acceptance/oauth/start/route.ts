import { NextResponse } from "next/server";

import { getAuthenticatedContext } from "@/lib/auth";
import { startGmailLiveAcceptanceOAuth } from "@/lib/operations/gmail-live-acceptance-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function unavailable() {
  return NextResponse.json(
    { error: "Not found." },
    { status: 404, headers: PRIVATE_HEADERS },
  );
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") return unavailable();
  const requestUrl = new URL(request.url);
  if (requestUrl.search) return unavailable();

  const auth = await getAuthenticatedContext();
  if (!auth) return unavailable();

  try {
    const authorization = await startGmailLiveAcceptanceOAuth({
      userId: auth.user.id,
      requestOrigin: requestUrl.origin,
    });
    return NextResponse.redirect(authorization.authorizationUrl, {
      status: 302,
      headers: PRIVATE_HEADERS,
    });
  } catch {
    return unavailable();
  }
}
