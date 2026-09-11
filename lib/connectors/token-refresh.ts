import "server-only";

import {
  prepareConnectionCredential,
  readConnectionSecret,
} from "@/lib/connectors/connection-vault";
import { ConnectorError } from "@/lib/connectors/errors";
import {
  runTokenRefresh,
  type RefreshTokens,
} from "@/lib/connectors/google/token-lifecycle-core";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type { RefreshTokens } from "@/lib/connectors/google/token-lifecycle-core";
export type TokenRefresher = (refreshToken: string) => Promise<RefreshTokens>;

export async function refreshConnectionToken(input: {
  userId: string;
  connectionId: string;
  connectorId: "google";
  refresh: TokenRefresher;
}) {
  const admin = createAdminClient();
  return runTokenRefresh({
    claimLease: async () => {
      const { data, error } = await admin.rpc("claim_connector_token_refresh", {
        p_connection_id: input.connectionId,
        p_user_id: input.userId,
        p_lease_seconds: 30,
      });
      return !error && data === true;
    },
    readRefreshToken: () =>
      readConnectionSecret({
        userId: input.userId,
        connectionId: input.connectionId,
        credentialKey: "refresh_token",
      }),
    requestTokens: input.refresh,
    isReconnectRequiredError: (error) =>
      error instanceof ConnectorError && error.details.category === "authentication",
    finalizeTokens: async (tokens) => {
      const accessCredential = prepareConnectionCredential({
        userId: input.userId,
        connectionId: input.connectionId,
        connectorId: input.connectorId,
        credentialKey: "access_token",
        credentialType: "oauth_access_token",
        plaintext: tokens.accessToken,
      });
      const refreshCredential = tokens.refreshToken
        ? prepareConnectionCredential({
            userId: input.userId,
            connectionId: input.connectionId,
            connectorId: input.connectorId,
            credentialKey: "refresh_token",
            credentialType: "oauth_refresh_token",
            plaintext: tokens.refreshToken,
          })
        : null;
      const { data, error } = await admin.rpc("finalize_google_token_refresh", {
        p_connection_id: input.connectionId,
        p_user_id: input.userId,
        p_token_expires_at: tokens.expiresAt,
        p_granted_scopes: tokens.grantedScopes ?? null,
        p_access_credential: accessCredential as Json,
        p_refresh_credential: refreshCredential as Json | null,
      });
      if (error || data !== true) {
        throw new Error("Refreshed Google credentials could not be finalized.");
      }
    },
    markReconnectRequired: async () => {
      const { error } = await admin
        .from("connector_connections")
        .update({
          status: "expired",
          last_error_category: "authentication",
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.connectionId)
        .eq("user_id", input.userId)
        .eq("provider_family", "google");
      if (error) throw new Error("Google reconnect state could not be stored.");
    },
    releaseLease: async () => {
      await admin.rpc("release_connector_token_refresh", {
        p_connection_id: input.connectionId,
        p_user_id: input.userId,
      });
    },
  });
}
