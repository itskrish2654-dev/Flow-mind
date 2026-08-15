import "server-only";

import { timingSafeEqual } from "node:crypto";

import { decryptCredential, encryptCredential, type CredentialContext } from "@/lib/security/credential-crypto";
import { createAdminClient } from "@/lib/supabase/admin";

const PROVIDER = "notion";
const CAPTURE_TTL_MS = 15 * 60 * 1_000;
const CAPTURE_CONTEXT: CredentialContext = {
  userId: "system:notion-webhook-setup",
  workflowId: "provider-setup:notion",
  connectorId: "notion",
  credentialKey: "webhook-verification-token",
};

function setupSecret() {
  const secret = process.env.FLOWMIND_CONNECTOR_NOTION_SETUP_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export function isAuthorizedNotionVerificationCaptureRequest(request: Request) {
  const expected = setupSecret();
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || !provided) return false;
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function captureInitialNotionVerificationToken(token: string) {
  if (!setupSecret()) return "capture_disabled" as const;
  const admin = createAdminClient();
  const now = new Date();
  await admin.from("connector_provider_setup_secrets").delete().eq("provider", PROVIDER).lte("expires_at", now.toISOString());
  const encrypted = encryptCredential(token, CAPTURE_CONTEXT);
  const { error } = await admin.from("connector_provider_setup_secrets").insert({
    provider: PROVIDER,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag,
    algorithm: encrypted.algorithm,
    encryption_version: encrypted.encryptionVersion,
    expires_at: new Date(now.getTime() + CAPTURE_TTL_MS).toISOString(),
  });
  if (error?.code === "23505") return "already_captured" as const;
  if (error) throw new Error("Notion verification token could not be captured.");
  return "captured" as const;
}

export async function consumeCapturedNotionVerificationToken(request: Request) {
  if (!setupSecret()) return { status: "disabled" as const };
  if (!isAuthorizedNotionVerificationCaptureRequest(request)) return { status: "unauthorized" as const };
  const admin = createAdminClient();
  const now = new Date().toISOString();
  await admin.from("connector_provider_setup_secrets").delete().eq("provider", PROVIDER).lte("expires_at", now);
  const { data, error } = await admin.from("connector_provider_setup_secrets")
    .delete().eq("provider", PROVIDER).gt("expires_at", now)
    .select("ciphertext,nonce,auth_tag,algorithm,encryption_version").maybeSingle();
  if (error) throw new Error("Notion verification token could not be retrieved.");
  if (!data) return { status: "empty" as const };
  const token = decryptCredential({
    ciphertext: data.ciphertext,
    nonce: data.nonce,
    authTag: data.auth_tag,
    algorithm: data.algorithm as "aes-256-gcm",
    encryptionVersion: data.encryption_version as 1,
  }, CAPTURE_CONTEXT);
  return { status: "captured" as const, token };
}
