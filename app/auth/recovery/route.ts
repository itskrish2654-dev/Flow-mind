import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getSiteOrigin, getSiteUrl } from "@/lib/site-origin";

/**
 * Recovery has its own callback path so its intent cannot be lost when an
 * email provider or OAuth redirect normalizes query parameters.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const siteOrigin = getSiteOrigin(requestUrl.origin);
  const code = requestUrl.searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL("/reset-password", siteOrigin));
    }
  }

  const loginUrl = new URL(getSiteUrl("/login", requestUrl.origin));
  loginUrl.searchParams.set("error", "recovery_failed");
  return NextResponse.redirect(loginUrl);
}
