import { NextResponse } from "next/server";
import { buildAuthorizationUrl } from "@/lib/connectors/oauth-exchange";
import { createOAuthAuthorization, safeOAuthReturnPath } from "@/lib/connectors/oauth";
import { getConnector } from "@/lib/connectors/registry";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params; const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/settings/connections", request.url));
  const connector = getConnector(connectorId);
  if (!connector || connector.manifest.auth.type !== "oauth2" || connector.manifest.status === "COMING_SOON" || (connector.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")) return NextResponse.json({ error: "Connector not found." }, { status: 404 });
  try { const requestUrl = new URL(request.url); const auth = await createOAuthAuthorization({ userId: user.id, connectorId, returnPath: safeOAuthReturnPath(requestUrl.searchParams.get("return")) }); const redirectUri = new URL(`/api/connectors/oauth/${connectorId}/callback`, request.url).toString(); return NextResponse.redirect(buildAuthorizationUrl({ connectorId, redirectUri, state: auth.state, codeChallenge: auth.codeChallenge, scopes: auth.scopes })); }
  catch { return NextResponse.redirect(new URL("/settings/connections?error=oauth_start_failed", request.url)); }
}
