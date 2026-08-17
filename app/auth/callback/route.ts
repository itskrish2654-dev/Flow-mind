import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getSiteOrigin, getSiteUrl } from "@/lib/site-origin";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const siteOrigin = getSiteOrigin(requestUrl.origin);
  const code = requestUrl.searchParams.get("code");
  const requestedNext = requestUrl.searchParams.get("next");
  const recovery = requestUrl.searchParams.get("type") === "recovery" || requestedNext === "/reset-password";
  const nextPath = recovery
    ? "/reset-password"
    : requestedNext?.startsWith("/dashboard")
      ? requestedNext
      : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(nextPath, siteOrigin));
  }

  const loginUrl = new URL(getSiteUrl("/login", requestUrl.origin));
  loginUrl.searchParams.set("error", recovery ? "recovery_failed" : "confirmation_failed");
  return NextResponse.redirect(loginUrl);
}
