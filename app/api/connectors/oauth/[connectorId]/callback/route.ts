import { NextResponse } from "next/server";
import { storeConnectionSecret } from "@/lib/connectors/connection-vault";
import { consumeOAuthState } from "@/lib/connectors/oauth";
import { exchangeAuthorizationCode } from "@/lib/connectors/oauth-exchange";
import { getConnector } from "@/lib/connectors/registry";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params; const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/settings/connections", request.url));
  const url = new URL(request.url); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); const connector = getConnector(connectorId);
  if (!code || !state || !connector || connector.manifest.auth.type !== "oauth2" || (connector.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")) return NextResponse.redirect(new URL("/settings/connections?error=invalid_callback", request.url));
  try {
    const oauth = await consumeOAuthState({ userId: user.id, connectorId, state }); const siteUrl = process.env.NEXT_PUBLIC_SITE_URL; if (!siteUrl) throw new Error("Site URL is missing."); const redirectUri = new URL(`/api/connectors/oauth/${connectorId}/callback`, siteUrl).toString(); const tokens = await exchangeAuthorizationCode({ connectorId, code, verifier: oauth.verifier, redirectUri, scopes: oauth.scopes }); const admin = createAdminClient();
    const canonicalConnectorId = connector.manifest.providerFamily === "google" ? "google" : connector.manifest.id;
    const { data: intended } = oauth.connectionId ? await admin.from("connector_connections").select("id,external_account_id,granted_scopes").eq("id", oauth.connectionId).eq("user_id", user.id).eq("provider_family", connector.manifest.providerFamily).maybeSingle() : { data: null };
    if (oauth.connectionId && (!intended || intended.external_account_id !== tokens.externalAccountId)) throw new Error("Google returned a different account than the selected connection.");
    const { data: existing } = intended ? { data: intended } : await admin.from("connector_connections").select("id,granted_scopes").eq("user_id", user.id).eq("connector_id", canonicalConnectorId).eq("external_account_id", tokens.externalAccountId).maybeSingle();
    const grantedScopes = Array.from(new Set([...(existing?.granted_scopes ?? []), ...tokens.scopes]));
    const accountLabel = connector.manifest.providerFamily === "google" ? tokens.externalAccountLabel?.toLowerCase() : tokens.externalAccountLabel;
    const { data: connection, error } = await admin.from("connector_connections").upsert({ user_id: user.id, connector_id: canonicalConnectorId, provider_family: connector.manifest.providerFamily, external_account_id: tokens.externalAccountId, external_account_label: accountLabel ?? null, auth_type: "oauth2", status: "connected", granted_scopes: grantedScopes, token_expires_at: tokens.expiresAt, last_refreshed_at: new Date().toISOString(), last_error_category: null, safe_metadata: { oauthConnector: connectorId }, updated_at: new Date().toISOString() }, { onConflict: "user_id,connector_id,external_account_id" }).select("id").single();
    if (error || !connection) throw new Error("Connection metadata could not be stored.");
    await storeConnectionSecret({ userId: user.id, connectionId: connection.id, credentialKey: "access_token", credentialType: "oauth_access_token", plaintext: tokens.accessToken });
    if (tokens.refreshToken) await storeConnectionSecret({ userId: user.id, connectionId: connection.id, credentialKey: "refresh_token", credentialType: "oauth_refresh_token", plaintext: tokens.refreshToken });
    await captureOperationalEvent({ level: "info", event: "google_connection_success", userId: user.id, status: "connected", metadata: { connector: connectorId } });
    return NextResponse.redirect(new URL(`${oauth.returnPath}${oauth.returnPath.includes("?") ? "&" : "?"}connected=${encodeURIComponent(connectorId)}`, request.url));
  } catch { await captureOperationalEvent({ level: "warn", event: "google_connection_failure", userId: user.id, status: "failed", errorCategory: "oauth" }); return NextResponse.redirect(new URL("/settings/connections?error=oauth_callback_failed", request.url)); }
}
