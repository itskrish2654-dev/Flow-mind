import { NextResponse } from "next/server";
import { storeConnectionSecret } from "@/lib/connectors/connection-vault";
import { consumeOAuthState, withOAuthResult } from "@/lib/connectors/oauth";
import { exchangeAuthorizationCode } from "@/lib/connectors/oauth-exchange";
import { getConnector } from "@/lib/connectors/registry";
import { revokeGoogleToken } from "@/lib/connectors/google/oauth-provider";
import { GOOGLE_LEGACY_SHEETS_SCOPE } from "@/lib/connectors/google/scopes";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSiteOrigin, getSiteUrl } from "@/lib/site-origin";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params; const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(getSiteUrl("/login?next=/connections", new URL(request.url).origin));
  const url = new URL(request.url); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); const providerError = url.searchParams.get("error"); const oauthCancelled = providerError === "access_denied" || providerError === "user_cancelled"; const connector = getConnector(connectorId);
  if (!state || !connector || connector.manifest.auth.type !== "oauth2" || (connector.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")) return NextResponse.redirect(getSiteUrl("/connections?error=invalid_callback", url.origin));
  let returnPath = "/connections";
  try {
    const oauth = await consumeOAuthState({ userId: user.id, connectorId, state });
    returnPath = oauth.returnPath;
    if (providerError || !code) throw new Error("OAuth authorization was cancelled.");
    const redirectUri = new URL(`/api/connectors/oauth/${connectorId}/callback`, getSiteOrigin(url.origin)).toString(); const tokens = await exchangeAuthorizationCode({ connectorId, code, verifier: oauth.verifier, redirectUri, scopes: oauth.scopes }); const admin = createAdminClient();
    if (connector.manifest.providerFamily === "google" && tokens.scopes.includes(GOOGLE_LEGACY_SHEETS_SCOPE)) {
      await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken);
      throw new Error("The previous broad Google Sheets permission must be removed before reconnecting.");
    }
    const canonicalConnectorId = connector.manifest.providerFamily === "google" ? "google" : connector.manifest.providerFamily;
    const { data: intended } = oauth.connectionId ? await admin.from("connector_connections").select("id,external_account_id,granted_scopes").eq("id", oauth.connectionId).eq("user_id", user.id).eq("provider_family", connector.manifest.providerFamily).maybeSingle() : { data: null };
    if (oauth.connectionId && (!intended || intended.external_account_id !== tokens.externalAccountId)) throw new Error("The provider returned a different account than the selected connection.");
    const { data: existing } = intended ? { data: intended } : await admin.from("connector_connections").select("id,granted_scopes").eq("user_id", user.id).eq("connector_id", canonicalConnectorId).eq("external_account_id", tokens.externalAccountId).maybeSingle();
    const grantedScopes = Array.from(new Set([...(existing?.granted_scopes ?? []), ...tokens.scopes])).filter((scope) => scope !== GOOGLE_LEGACY_SHEETS_SCOPE);
    const accountLabel = connector.manifest.providerFamily === "google" ? tokens.externalAccountLabel?.toLowerCase() : tokens.externalAccountLabel;
    const { data: connection, error } = await admin.from("connector_connections").upsert({ user_id: user.id, connector_id: canonicalConnectorId, provider_family: connector.manifest.providerFamily, external_account_id: tokens.externalAccountId, external_account_label: accountLabel ?? null, auth_type: "oauth2", status: "connected", granted_scopes: grantedScopes, token_expires_at: tokens.expiresAt, last_refreshed_at: new Date().toISOString(), last_error_category: null, safe_metadata: { oauthConnector: connectorId, ...(tokens.safeMetadata ?? {}) }, updated_at: new Date().toISOString() }, { onConflict: "user_id,connector_id,external_account_id" }).select("id").single();
    if (error || !connection) throw new Error("Connection metadata could not be stored.");
    await storeConnectionSecret({ userId: user.id, connectionId: connection.id, credentialKey: "access_token", credentialType: "oauth_access_token", plaintext: tokens.accessToken });
    if (tokens.refreshToken) await storeConnectionSecret({ userId: user.id, connectionId: connection.id, credentialKey: "refresh_token", credentialType: "oauth_refresh_token", plaintext: tokens.refreshToken });
    const connectionSuccessEvent = connector.manifest.providerFamily === "google" ? "google_connection_success" : connector.manifest.providerFamily === "slack" ? "slack_connection_success" : "notion_connection_success";
    await captureOperationalEvent({ level: "info", event: connectionSuccessEvent, userId: user.id, status: "connected", metadata: { connector: connectorId } });
    return NextResponse.redirect(getSiteUrl(withOAuthResult(returnPath, "connected", connectorId), url.origin));
  } catch { const connectionFailureEvent = connector?.manifest.providerFamily === "google" ? "google_connection_failure" : connector?.manifest.providerFamily === "slack" ? "slack_connection_failure" : "notion_connection_failure"; await captureOperationalEvent({ level: "warn", event: connectionFailureEvent, userId: user.id, status: "failed", errorCategory: "oauth" }); return NextResponse.redirect(getSiteUrl(withOAuthResult(returnPath, "connection_error", oauthCancelled ? "oauth_cancelled" : "oauth_callback_failed"), url.origin)); }
}
