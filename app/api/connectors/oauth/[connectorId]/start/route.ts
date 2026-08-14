import { NextResponse } from "next/server";
import { buildAuthorizationUrl } from "@/lib/connectors/oauth-exchange";
import { createOAuthAuthorization, safeOAuthReturnPath } from "@/lib/connectors/oauth";
import { getConnector } from "@/lib/connectors/registry";
import { googleScopesForOperation } from "@/lib/connectors/google/scopes";
import { slackScopesForOperation } from "@/lib/connectors/slack/scopes";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params; const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/settings/connections", request.url));
  const connector = getConnector(connectorId);
  if (!connector || connector.manifest.auth.type !== "oauth2" || connector.manifest.status === "COMING_SOON" || (connector.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")) return NextResponse.json({ error: "Connector not found." }, { status: 404 });
  try {
    const requestUrl = new URL(request.url); const operationKey = requestUrl.searchParams.get("operation"); const connectionId = requestUrl.searchParams.get("connection");
    const operation = [...connector.manifest.triggers, ...connector.manifest.actions].find((item) => item.key === operationKey) ?? null;
    if (operationKey && !operation) throw new Error("Unknown connector operation.");
    let loginHint: string | null = null;
    if (connectionId) {
      const { data } = await createAdminClient().from("connector_connections").select("id,external_account_label,provider_family").eq("id", connectionId).eq("user_id", user.id).eq("provider_family", connector.manifest.providerFamily).maybeSingle();
      if (!data) throw new Error("Connection not found.");
      loginHint = data.external_account_label;
    }
    const scopes = connector.manifest.providerFamily === "google"
      ? googleScopesForOperation(connectorId, operation?.key)
      : connector.manifest.providerFamily === "slack"
        ? slackScopesForOperation(operation?.key)
        : operation?.requiredScopes;
    const auth = await createOAuthAuthorization({ userId: user.id, connectorId, scopes, returnPath: safeOAuthReturnPath(requestUrl.searchParams.get("return")), ...(connectionId ? { connectionId } : {}), ...(operation?.key ? { operationKey: operation.key } : {}) });
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL; if (!siteUrl) throw new Error("Site URL is missing.");
    const redirectUri = new URL(`/api/connectors/oauth/${connectorId}/callback`, siteUrl).toString();
    return NextResponse.redirect(buildAuthorizationUrl({ connectorId, redirectUri, state: auth.state, codeChallenge: auth.codeChallenge, scopes: auth.scopes, loginHint, selectAccount: requestUrl.searchParams.get("account") === "add" }));
  }
  catch { return NextResponse.redirect(new URL("/settings/connections?error=oauth_start_failed", request.url)); }
}
