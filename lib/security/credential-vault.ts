import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  decryptCredential,
  encryptCredential,
  type CredentialContext,
} from "@/lib/security/credential-crypto";

export type CredentialMetadata = {
  connectorId: string;
  credentialKey: string;
  credentialType: string;
  configured: true;
  updatedAt: string;
};

export async function storeCredential(
  context: CredentialContext,
  credentialType: string,
  plaintext: string,
): Promise<CredentialMetadata> {
  const admin = createAdminClient();
  const encrypted = encryptCredential(plaintext, context);
  const updatedAt = new Date().toISOString();
  const { error } = await admin.from("workflow_credentials").upsert(
    {
      user_id: context.userId,
      workflow_id: context.workflowId,
      connector_id: context.connectorId,
      credential_key: context.credentialKey,
      credential_type: credentialType,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      auth_tag: encrypted.authTag,
      algorithm: encrypted.algorithm,
      encryption_version: encrypted.encryptionVersion,
      updated_at: updatedAt,
    },
    { onConflict: "user_id,workflow_id,connector_id,credential_key" },
  );
  if (error) throw new Error("Credential could not be stored securely.");
  return {
    connectorId: context.connectorId,
    credentialKey: context.credentialKey,
    credentialType,
    configured: true,
    updatedAt,
  };
}

export async function listCredentialMetadata(
  userId: string,
  workflowId: string,
): Promise<CredentialMetadata[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workflow_credentials")
    .select("connector_id, credential_key, credential_type, updated_at")
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) throw new Error("Credential metadata could not be loaded.");
  return (data ?? []).map((item) => ({
    connectorId: item.connector_id,
    credentialKey: item.credential_key,
    credentialType: item.credential_type,
    configured: true,
    updatedAt: item.updated_at,
  }));
}

export async function readCredential(context: CredentialContext): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workflow_credentials")
    .select("ciphertext, nonce, auth_tag, algorithm, encryption_version")
    .eq("user_id", context.userId)
    .eq("workflow_id", context.workflowId)
    .eq("connector_id", context.connectorId)
    .eq("credential_key", context.credentialKey)
    .maybeSingle();
  if (error || !data) throw new Error("Credential is unavailable.");
  return decryptCredential(
    {
      ciphertext: data.ciphertext,
      nonce: data.nonce,
      authTag: data.auth_tag,
      algorithm: data.algorithm as "aes-256-gcm",
      encryptionVersion: data.encryption_version as 1,
    },
    context,
  );
}

export async function deleteCredential(context: CredentialContext): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("workflow_credentials")
    .delete()
    .eq("user_id", context.userId)
    .eq("workflow_id", context.workflowId)
    .eq("connector_id", context.connectorId)
    .eq("credential_key", context.credentialKey);
  if (error) throw new Error("Credential could not be removed.");
}
