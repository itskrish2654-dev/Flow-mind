import "server-only";

import { readConnectionSecret, storeConnectionSecret } from "@/lib/connectors/connection-vault";
import { createAdminClient } from "@/lib/supabase/admin";

export type RefreshTokens = { accessToken: string; refreshToken?: string; expiresAt: string; grantedScopes?: string[] };
export type TokenRefresher = (refreshToken: string) => Promise<RefreshTokens>;

export async function refreshConnectionToken(input: { userId: string; connectionId: string; refresh: TokenRefresher }) {
  const admin = createAdminClient();
  const { data: claimed, error: claimError } = await admin.rpc("claim_connector_token_refresh", { p_connection_id: input.connectionId, p_user_id: input.userId, p_lease_seconds: 30 });
  if (claimError || !claimed) return { refreshed: false as const, reason: "refresh_in_progress" as const };
  try {
    const refreshToken = await readConnectionSecret({ userId: input.userId, connectionId: input.connectionId, credentialKey: "refresh_token" });
    const tokens = await input.refresh(refreshToken);
    await storeConnectionSecret({ userId: input.userId, connectionId: input.connectionId, credentialKey: "access_token", credentialType: "oauth_access_token", plaintext: tokens.accessToken });
    if (tokens.refreshToken) await storeConnectionSecret({ userId: input.userId, connectionId: input.connectionId, credentialKey: "refresh_token", credentialType: "oauth_refresh_token", plaintext: tokens.refreshToken });
    const update: { status: "connected"; token_expires_at: string; last_refreshed_at: string; last_error_category: null; updated_at: string; granted_scopes?: string[] } = { status: "connected", token_expires_at: tokens.expiresAt, last_refreshed_at: new Date().toISOString(), last_error_category: null, updated_at: new Date().toISOString() };
    if (tokens.grantedScopes) update.granted_scopes = tokens.grantedScopes;
    const { error } = await admin.from("connector_connections").update(update).eq("id", input.connectionId).eq("user_id", input.userId);
    if (error) throw new Error("Refreshed connection metadata could not be stored.");
    return { refreshed: true as const, expiresAt: tokens.expiresAt };
  } catch (error) {
    await admin.from("connector_connections").update({ status: "expired", last_error_category: "authentication", updated_at: new Date().toISOString() }).eq("id", input.connectionId).eq("user_id", input.userId);
    throw error;
  } finally {
    await admin.rpc("release_connector_token_refresh", { p_connection_id: input.connectionId, p_user_id: input.userId });
  }
}
