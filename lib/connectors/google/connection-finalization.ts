import "server-only";

import { randomUUID } from "node:crypto";

import {
  prepareConnectionCredential,
  type PreparedConnectionCredential,
} from "@/lib/connectors/connection-vault";
import {
  assertGoogleOAuthHasDurableRefresh,
  assertGoogleReconnectAccount,
  unionGoogleScopes,
  type ExistingGoogleConnection,
} from "@/lib/connectors/google/oauth-finalization-core";
import { GOOGLE_LEGACY_SHEETS_SCOPE } from "@/lib/connectors/google/scopes";
import type { OAuthTokenSet } from "@/lib/connectors/oauth-exchange";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

function asExistingConnection(
  row: {
    id: string;
    external_account_id: string;
    status: "connected" | "expired" | "revoked" | "error";
    last_error_category: string | null;
    granted_scopes: string[];
  },
  hasRefreshCredential: boolean,
): ExistingGoogleConnection {
  return {
    id: row.id,
    externalAccountId: row.external_account_id,
    status: row.status,
    lastErrorCategory: row.last_error_category,
    grantedScopes: row.granted_scopes,
    hasRefreshCredential,
  };
}

async function hasOwnedRefreshCredential(userId: string, connectionId: string) {
  const { data } = await createAdminClient()
    .from("connector_connection_credentials")
    .select("id")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .eq("credential_key", "refresh_token")
    .maybeSingle();
  return Boolean(data);
}

function credentialJson(credential: PreparedConnectionCredential): Json {
  return credential;
}

export async function finalizeGoogleOAuthConnection(input: {
  userId: string;
  oauthConnectorId: string;
  intendedConnectionId: string | null;
  tokens: OAuthTokenSet;
}) {
  const admin = createAdminClient();
  const select = "id,external_account_id,status,last_error_category,granted_scopes";
  const { data: intended } = input.intendedConnectionId
    ? await admin
        .from("connector_connections")
        .select(select)
        .eq("id", input.intendedConnectionId)
        .eq("user_id", input.userId)
        .eq("provider_family", "google")
        .maybeSingle()
    : { data: null };

  if (input.intendedConnectionId && !intended) {
    throw new Error("The selected Google connection is unavailable.");
  }
  assertGoogleReconnectAccount(
    intended ? { externalAccountId: intended.external_account_id } : null,
    input.tokens.externalAccountId,
  );

  const { data: discovered } = intended
    ? { data: intended }
    : await admin
        .from("connector_connections")
        .select(select)
        .eq("user_id", input.userId)
        .eq("connector_id", "google")
        .eq("external_account_id", input.tokens.externalAccountId)
        .maybeSingle();

  const hasRefreshCredential = discovered
    ? await hasOwnedRefreshCredential(input.userId, discovered.id)
    : false;
  const existing = discovered
    ? asExistingConnection(discovered, hasRefreshCredential)
    : null;
  assertGoogleOAuthHasDurableRefresh({
    existing,
    returnedRefreshToken: input.tokens.refreshToken,
  });

  const connectionId = existing?.id ?? randomUUID();
  const grantedScopes = unionGoogleScopes(
    existing?.grantedScopes ?? [],
    input.tokens.scopes,
    GOOGLE_LEGACY_SHEETS_SCOPE,
  );
  const accessCredential = prepareConnectionCredential({
    userId: input.userId,
    connectionId,
    connectorId: "google",
    credentialKey: "access_token",
    credentialType: "oauth_access_token",
    plaintext: input.tokens.accessToken,
  });
  const refreshCredential = input.tokens.refreshToken
    ? prepareConnectionCredential({
        userId: input.userId,
        connectionId,
        connectorId: "google",
        credentialKey: "refresh_token",
        credentialType: "oauth_refresh_token",
        plaintext: input.tokens.refreshToken,
      })
    : null;

  const { data, error } = await admin.rpc("finalize_google_oauth_connection", {
    p_connection_id: connectionId,
    p_user_id: input.userId,
    p_external_account_id: input.tokens.externalAccountId,
    p_external_account_label: input.tokens.externalAccountLabel?.toLowerCase() ?? null,
    p_granted_scopes: grantedScopes,
    p_token_expires_at: input.tokens.expiresAt,
    p_safe_metadata: {
      oauthConnector: input.oauthConnectorId,
      ...(input.tokens.safeMetadata ?? {}),
    },
    p_access_credential: credentialJson(accessCredential),
    p_refresh_credential: refreshCredential ? credentialJson(refreshCredential) : null,
  });
  if (error || data !== connectionId) {
    throw new Error("Google connection credentials could not be finalized.");
  }
  return { id: connectionId, grantedScopes };
}
