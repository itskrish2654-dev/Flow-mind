import { NextResponse } from "next/server";

import { startGmailLiveAcceptanceOAuth } from "@/lib/operations/gmail-live-acceptance-oauth";
import { createClient } from "@/lib/supabase/server";

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
  const requestUrl = new URL(request.url);
  if (requestUrl.search) return unavailable();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return unavailable();

  try {
    const authorization = await startGmailLiveAcceptanceOAuth({
      userId: user.id,
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
