import { NextResponse } from "next/server";

import { getAuthenticatedContext } from "@/lib/auth";
import { getConnectorOnboarding } from "@/lib/capability-registry";
import { googleSheetsAcceptanceConnector } from "@/lib/google-sheets-live-acceptance";
import { notionAcceptanceConnector } from "@/lib/notion-live-acceptance";
import { storeConnectionSecret } from "@/lib/connectors/connection-vault";
import { finalizeGoogleOAuthConnection } from "@/lib/connectors/google/connection-finalization";
import { revokeGoogleToken } from "@/lib/connectors/google/oauth-provider";
import { GOOGLE_LEGACY_SHEETS_SCOPE } from "@/lib/connectors/google/scopes";
import { consumeOAuthState, withOAuthResult } from "@/lib/connectors/oauth";
import { exchangeAuthorizationCode } from "@/lib/connectors/oauth-exchange";
import { getConnector } from "@/lib/connectors/registry";
import { NotionVerificationError } from "@/lib/connectors/notion/oauth-provider";
import {
  finalizeGmailLiveAcceptanceConnection,
  getGmailLiveAcceptanceCallbackContext,
} from "@/lib/operations/gmail-live-acceptance-oauth";
import { initializeGmailWorkIntake } from "@/lib/connectors/google/gmail-push";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSiteOrigin, getSiteUrl } from "@/lib/site-origin";

function privateRedirect(path: string, fallbackOrigin: string) {
  const response = NextResponse.redirect(getSiteUrl(path, fallbackOrigin));
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectorId: string }> },
) {
  const { connectorId } = await params;
  const auth = await getAuthenticatedContext();
  if (!auth) {
    return privateRedirect("/login?next=/connections", new URL(request.url).origin);
  }
  const { user } = auth;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const oauthCancelled = providerError === "access_denied" || providerError === "user_cancelled";
  const connector = getConnector(connectorId);
  const ordinaryOnboardingAvailable = Boolean(getConnectorOnboarding(connectorId)?.available || googleSheetsAcceptanceConnector(connectorId) || notionAcceptanceConnector(connectorId));
  const mayBeGmailAcceptance = connectorId === "google_gmail";

  if (
    !state
    || !connector
    || (!ordinaryOnboardingAvailable && !mayBeGmailAcceptance)
    || connector.manifest.auth.type !== "oauth2"
    || (connector.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")
  ) {
    return privateRedirect("/connections?error=invalid_callback", url.origin);
  }

  let returnPath = "/connections";
  let callbackStage = "state_validation";
  try {
    const oauth = await consumeOAuthState({ userId: user.id, connectorId, state });
    callbackStage = "provider_exchange";
    returnPath = oauth.returnPath;
    const acceptanceContext = getGmailLiveAcceptanceCallbackContext({
      connectorId,
      userId: user.id,
      oauth,
    });
    if (!ordinaryOnboardingAvailable && !acceptanceContext) {
      throw new Error("This connector is not available.");
    }
    if (providerError || !code) throw new Error("OAuth authorization was cancelled.");

    const redirectUri = new URL(
      `/api/connectors/oauth/${connectorId}/callback`,
      getSiteOrigin(url.origin),
    ).toString();
    const tokens = await exchangeAuthorizationCode({
      connectorId,
      code,
      verifier: oauth.verifier,
      redirectUri,
      scopes: oauth.scopes,
    });

    if (acceptanceContext) {
      await finalizeGmailLiveAcceptanceConnection({
        userId: user.id,
        tokens,
        context: acceptanceContext,
      });
    } else if (connector.manifest.providerFamily === "google") {
      if (tokens.scopes.includes(GOOGLE_LEGACY_SHEETS_SCOPE)) {
        await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken);
        throw new Error("The previous broad Google Sheets permission must be removed before reconnecting.");
      }
      const connection = await finalizeGoogleOAuthConnection({
        userId: user.id,
        oauthConnectorId: connectorId,
        intendedConnectionId: oauth.connectionId,
        tokens,
      });
      if (connectorId === "google_gmail") {
        try {
          await initializeGmailWorkIntake({ userId: user.id, connectionId: connection.id });
        } catch {
          await createAdminClient().from("connector_connections").update({
            last_error_category: "gmail_intake_setup",
            updated_at: new Date().toISOString(),
          }).eq("id", connection.id).eq("user_id", user.id).eq("workspace_id", auth.workspace.id);
        }
      }
    } else {
      callbackStage = "connection_lookup";
      const admin = createAdminClient();
      const canonicalConnectorId = connector.manifest.providerFamily;
      const { data: intended } = oauth.connectionId
        ? await admin
            .from("connector_connections")
            .select("id,external_account_id,granted_scopes")
            .eq("id", oauth.connectionId)
            .eq("user_id", user.id)
            .eq("workspace_id", auth.workspace.id)
            .eq("provider_family", connector.manifest.providerFamily)
            .maybeSingle()
        : { data: null };
      if (oauth.connectionId && (!intended || intended.external_account_id !== tokens.externalAccountId)) {
        throw new Error("The provider returned a different account than the selected connection.");
      }
      const { data: existing } = intended
        ? { data: intended }
        : await admin
            .from("connector_connections")
            .select("id,granted_scopes")
            .eq("user_id", user.id)
            .eq("workspace_id", auth.workspace.id)
            .eq("connector_id", canonicalConnectorId)
            .eq("external_account_id", tokens.externalAccountId)
            .maybeSingle();
      // Slack reinstalls and Notion capability changes can remove grants.
      // Their latest provider-confirmed token is authoritative, not old rows.
      const grantedScopes = connector.manifest.providerFamily === "slack" || connector.manifest.providerFamily === "notion"
        ? tokens.scopes
        : Array.from(new Set([...(existing?.granted_scopes ?? []), ...tokens.scopes]));
      callbackStage = "connection_write";
      const { data: connection, error } = await admin
        .from("connector_connections")
        .upsert({
          user_id: user.id,
          workspace_id: auth.workspace.id,
          connector_id: canonicalConnectorId,
          provider_family: connector.manifest.providerFamily,
          external_account_id: tokens.externalAccountId,
          external_account_label: tokens.externalAccountLabel ?? null,
          auth_type: "oauth2",
          status: "connected",
          granted_scopes: grantedScopes,
          token_expires_at: tokens.expiresAt,
          last_refreshed_at: new Date().toISOString(),
          last_error_category: null,
          safe_metadata: { oauthConnector: connectorId, ...(tokens.safeMetadata ?? {}) },
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,connector_id,external_account_id" })
        .select("id")
        .single();
      if (error || !connection) throw new Error("Connection metadata could not be stored.");
      callbackStage = "credential_write";
      try {
        await storeConnectionSecret({
          userId: user.id,
          connectionId: connection.id,
          credentialKey: "access_token",
          credentialType: "oauth_access_token",
          plaintext: tokens.accessToken,
        });
        if (tokens.refreshToken) {
          await storeConnectionSecret({
            userId: user.id,
            connectionId: connection.id,
            credentialKey: "refresh_token",
            credentialType: "oauth_refresh_token",
            plaintext: tokens.refreshToken,
          });
        }
      } catch {
        await admin.from("connector_connections").update({
          status: "error", last_error_category: "credential_storage", updated_at: new Date().toISOString(),
        }).eq("id", connection.id).eq("user_id", user.id).eq("workspace_id", auth.workspace.id);
        throw new Error("Connection credentials could not be stored.");
      }
      if (connectorId === "google_gmail") {
        try {
          await initializeGmailWorkIntake({ userId: user.id, connectionId: connection.id });
        } catch {
          await admin.from("connector_connections").update({
            last_error_category: "gmail_intake_setup",
            updated_at: new Date().toISOString(),
          }).eq("id", connection.id).eq("user_id", user.id).eq("workspace_id", auth.workspace.id);
        }
      }
    }

    const connectionSuccessEvent = connector.manifest.providerFamily === "google"
      ? "google_connection_success"
      : connector.manifest.providerFamily === "slack"
        ? "slack_connection_success"
        : "notion_connection_success";
    await captureOperationalEvent({
      level: "info",
      event: connectionSuccessEvent,
      userId: user.id,
      status: "connected",
      metadata: { connector: connectorId },
    });
    return privateRedirect(withOAuthResult(returnPath, "connected", connectorId), url.origin);
  } catch (error) {
    const connectionFailureEvent = connector?.manifest.providerFamily === "google"
      ? "google_connection_failure"
      : connector?.manifest.providerFamily === "slack"
        ? "slack_connection_failure"
        : "notion_connection_failure";
    await captureOperationalEvent({
      level: "warn",
      event: connectionFailureEvent,
      userId: user.id,
      status: "failed",
      errorCategory: "oauth",
      ...(connector?.manifest.providerFamily === "notion" && notionAcceptanceConnector(connectorId)
        ? { metadata: { failurePoint: error instanceof NotionVerificationError ? error.failurePoint : callbackStage } }
        : {}),
    });
    return privateRedirect(
      withOAuthResult(returnPath, "connection_error", oauthCancelled ? "oauth_cancelled" : "oauth_callback_failed"),
      url.origin,
    );
  }
}
