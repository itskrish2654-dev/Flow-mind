import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { getConnector } from "@/lib/connectors/registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptCredential, encryptCredential } from "@/lib/security/credential-crypto";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function safeOAuthReturnPath(value: string | null | undefined): string {
  if (!value || !/^\/[A-Za-z0-9/_?=&.%-]*$/.test(value) || value.startsWith("//")) return "/connections";
  return value;
}

function stateHash(state: string) { return createHash("sha256").update(state).digest("hex"); }

export async function createOAuthAuthorization(input: { userId: string; connectorId: string; scopes?: string[]; returnPath?: string; connectionId?: string; operationKey?: string }) {
  const registered = getConnector(input.connectorId);
  if (!registered || registered.manifest.auth.type !== "oauth2") throw new Error("OAuth is not available for this connector.");
  if (registered.manifest.status === "COMING_SOON" || (registered.manifest.status === "INTERNAL" && process.env.NODE_ENV === "production")) throw new Error("This connector is not available.");
  const state = randomBytes(32).toString("base64url");
  const pkce = createPkcePair();
  const hash = stateHash(state);
  const encrypted = encryptCredential(pkce.verifier, { userId: input.userId, workflowId: `oauth:${hash}`, connectorId: input.connectorId, credentialKey: "pkce_verifier" });
  const scopes = Array.from(new Set(input.scopes?.length ? input.scopes : registered.manifest.auth.defaultScopes));
  const returnPath = safeOAuthReturnPath(input.returnPath);
  const { error } = await createAdminClient().from("connector_oauth_states").insert({
    state_hash: hash, user_id: input.userId, connector_id: input.connectorId, provider_family: registered.manifest.providerFamily,
    requested_scopes: scopes, return_path: returnPath, pkce_ciphertext: encrypted.ciphertext, pkce_nonce: encrypted.nonce,
    pkce_auth_tag: encrypted.authTag, expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
    ...(input.connectionId ? { intended_connection_id: input.connectionId } : {}),
    ...(input.operationKey ? { operation_key: input.operationKey } : {}),
  });
  if (error) throw new Error("OAuth authorization could not be started.");
  return { state, codeChallenge: pkce.challenge, scopes, returnPath };
}

export async function consumeOAuthState(input: { userId: string; connectorId: string; state: string }) {
  const hash = stateHash(input.state);
  const admin = createAdminClient();
  const { data, error } = await admin.from("connector_oauth_states").select("*").eq("state_hash", hash).eq("user_id", input.userId).eq("connector_id", input.connectorId).is("consumed_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error || !data) throw new Error("OAuth state is invalid or expired.");
  const consumedAt = new Date().toISOString();
  const { data: consumed, error: consumeError } = await admin.from("connector_oauth_states").update({ consumed_at: consumedAt }).eq("state_hash", hash).eq("user_id", input.userId).is("consumed_at", null).select("state_hash").maybeSingle();
  if (consumeError || !consumed) throw new Error("OAuth state was already used.");
  const verifier = decryptCredential({ ciphertext: data.pkce_ciphertext, nonce: data.pkce_nonce, authTag: data.pkce_auth_tag, algorithm: "aes-256-gcm", encryptionVersion: 1 }, { userId: input.userId, workflowId: `oauth:${hash}`, connectorId: input.connectorId, credentialKey: "pkce_verifier" });
  return { verifier, scopes: data.requested_scopes, returnPath: safeOAuthReturnPath(data.return_path), providerFamily: data.provider_family, connectionId: data.intended_connection_id, operationKey: data.operation_key };
}
