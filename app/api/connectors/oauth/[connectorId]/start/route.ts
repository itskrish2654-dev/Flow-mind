import { NextResponse } from "next/server";
import { getAuthenticatedContext } from "@/lib/auth";
import { getConnectorOnboarding } from "@/lib/capability-registry";
import { buildAuthorizationUrl } from "@/lib/connectors/oauth-exchange";
import { createOAuthAuthorization, oauthReturnWorkflowId, safeOAuthReturnPath, withOAuthResult } from "@/lib/connectors/oauth";
import { getConnector } from "@/lib/connectors/registry";
import { googleScopesForOperation } from "@/lib/connectors/google/scopes";
import { prepareGoogleConnectionForDriveFileReconnect } from "@/lib/connectors/google/selected-spreadsheets";
import { slackScopesForOperation } from "@/lib/connectors/slack/scopes";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSiteOrigin, getSiteUrl } from "@/lib/site-origin";
import { googleSheetsAcceptanceConnector } from "@/lib/google-sheets-live-acceptance";
import { notionAcceptanceConnector } from "@/lib/notion-live-acceptance";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params; const auth = await getAuthenticatedContext();
  if (!auth) return NextResponse.redirect(getSiteUrl("/login?next=/connections", new URL(request.url).origin));
  const { user } = auth;
  const connector = getConnector(connectorId);
  if (!connector || !(getConnectorOnboarding(connectorId)?.available || googleSheetsAcceptanceConnector(connectorId) || notionAcceptanceConnector(connectorId)) || connector.manifest.auth.type !== "oauth2" || connector.manifest.status === "COMING_SOON" || (connector.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")) return NextResponse.json({ error: "Connector not found." }, { status: 404 });
  const requestUrl = new URL(request.url);
  let returnPath = "/connections";
  try {
    const requestedReturnPath = safeOAuthReturnPath(requestUrl.searchParams.get("return"));
    const returnWorkflowId = oauthReturnWorkflowId(requestedReturnPath);
    if (returnWorkflowId) {
      const { data: ownedWorkflow } = await createAdminClient().from("workflows").select("id").eq("id", returnWorkflowId).eq("user_id", user.id).eq("workspace_id", auth.workspace.id).maybeSingle();
      if (!ownedWorkflow) throw new Error("Workflow return target is unavailable.");
    }
    returnPath = requestedReturnPath;
    const operationKey = requestUrl.searchParams.get("operation"); const connectionId = requestUrl.searchParams.get("connection");
    const operation = [...connector.manifest.triggers, ...connector.manifest.actions].find((item) => item.key === operationKey) ?? null;
    if (operationKey && !operation) throw new Error("Unknown connector operation.");
    let loginHint: string | null = null;
    if (connectionId) {
      const { data } = await createAdminClient().from("connector_connections").select("id,external_account_label,provider_family").eq("id", connectionId).eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", connector.manifest.providerFamily).maybeSingle();
      if (!data) throw new Error("Connection not found.");
      loginHint = data.external_account_label;
      if (connector.manifest.providerFamily === "google") {
        await prepareGoogleConnectionForDriveFileReconnect({ userId: user.id, connectionId: data.id });
      }
    }
    const scopes = connector.manifest.providerFamily === "google"
      ? googleScopesForOperation(connectorId, operation?.key)
      : connector.manifest.providerFamily === "slack"
        ? slackScopesForOperation(operation?.key)
        : operation?.requiredScopes;
    const authorization = await createOAuthAuthorization({ userId: user.id, connectorId, scopes, returnPath, ...(connectionId ? { connectionId } : {}), ...(operation?.key ? { operationKey: operation.key } : {}) });
    const redirectUri = new URL(`/api/connectors/oauth/${connectorId}/callback`, getSiteOrigin(new URL(request.url).origin)).toString();
    return NextResponse.redirect(buildAuthorizationUrl({ connectorId, redirectUri, state: authorization.state, codeChallenge: authorization.codeChallenge, scopes: authorization.scopes, loginHint, selectAccount: requestUrl.searchParams.get("account") === "add" }));
  }
  catch { return NextResponse.redirect(getSiteUrl(withOAuthResult(returnPath, "connection_error", "oauth_start_failed"), requestUrl.origin)); }
}
