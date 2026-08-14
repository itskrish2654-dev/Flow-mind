import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptCredential, encryptCredential, type CredentialContext } from "@/lib/security/credential-crypto";

function context(userId: string, connectionId: string, connectorId: string, credentialKey: string): CredentialContext {
  return { userId, workflowId: `connection:${connectionId}`, connectorId, credentialKey };
}

async function assertOwnedConnection(userId: string, connectionId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("connector_connections").select("id, connector_id, provider_family, status").eq("id", connectionId).eq("user_id", userId).maybeSingle();
  if (error || !data || data.status === "revoked") throw new Error("Connection is unavailable.");
  return data;
}

export async function storeConnectionSecret(input: { userId: string; connectionId: string; credentialKey: string; credentialType: string; plaintext: string }) {
  const connection = await assertOwnedConnection(input.userId, input.connectionId);
  const encrypted = encryptCredential(input.plaintext, context(input.userId, input.connectionId, connection.connector_id, input.credentialKey));
  const { error } = await createAdminClient().from("connector_connection_credentials").upsert({
    connection_id: input.connectionId, user_id: input.userId, credential_key: input.credentialKey, credential_type: input.credentialType,
    ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, auth_tag: encrypted.authTag, algorithm: encrypted.algorithm,
    encryption_version: encrypted.encryptionVersion, updated_at: new Date().toISOString(),
  }, { onConflict: "connection_id,credential_key" });
  if (error) throw new Error("Connection credential could not be stored.");
}

export async function readConnectionSecret(input: { userId: string; connectionId: string; credentialKey: string }) {
  const connection = await assertOwnedConnection(input.userId, input.connectionId);
  const { data, error } = await createAdminClient().from("connector_connection_credentials")
    .select("ciphertext, nonce, auth_tag, algorithm, encryption_version")
    .eq("connection_id", input.connectionId).eq("user_id", input.userId).eq("credential_key", input.credentialKey).maybeSingle();
  if (error || !data) throw new Error("Connection credential is unavailable.");
  return decryptCredential({ ciphertext: data.ciphertext, nonce: data.nonce, authTag: data.auth_tag, algorithm: data.algorithm as "aes-256-gcm", encryptionVersion: data.encryption_version as 1 }, context(input.userId, input.connectionId, connection.connector_id, input.credentialKey));
}

export async function revokeConnection(userId: string, connectionId: string) {
  const connection = await assertOwnedConnection(userId, connectionId);
  const admin = createAdminClient();
  if (connection.provider_family === "google") {
    const refreshToken = await readConnectionSecret({ userId, connectionId, credentialKey: "refresh_token" }).catch(() => null);
    const accessToken = refreshToken ? null : await readConnectionSecret({ userId, connectionId, credentialKey: "access_token" }).catch(() => null);
    const { stopGmailWatch } = await import("@/lib/connectors/google/gmail-push");
    await stopGmailWatch({ userId, connectionId });
    if (refreshToken || accessToken) {
      const { revokeGoogleToken } = await import("@/lib/connectors/google/oauth-provider");
      await revokeGoogleToken(refreshToken ?? accessToken!).catch(() => false);
    }
  }
  const { error: credentialError } = await admin.from("connector_connection_credentials").delete().eq("connection_id", connectionId).eq("user_id", userId);
  if (credentialError) throw new Error("Connection secrets could not be removed.");
  const { error } = await admin.from("connector_connections").update({ status: "revoked", granted_scopes: [], token_expires_at: null, updated_at: new Date().toISOString() }).eq("id", connectionId).eq("user_id", userId);
  if (error) throw new Error("Connection could not be disconnected.");
  await admin.from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("connection_id", connectionId).eq("user_id", userId);
}

export async function revokeAllUserConnections(userId: string) {
  const admin = createAdminClient();
  for (;;) {
    const { data, error } = await admin.from("connector_connections").select("id").eq("user_id", userId).neq("status", "revoked").limit(100);
    if (error) throw new Error("Connection inventory could not be loaded.");
    if (!data?.length) break;
    for (const connection of data) await revokeConnection(userId, connection.id);
  }
}
