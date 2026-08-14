import { z } from "zod";

import {
  decryptCredential,
  encryptCredential,
  type EncryptedCredential,
} from "@/lib/security/credential-crypto";
import { HOMEPAGE_DEMO_MAX_PROMPT_LENGTH } from "@/lib/homepage-demo";

const DraftPayloadSchema = z.object({
  version: z.literal(1),
  prompt: z.string().trim().min(1).max(HOMEPAGE_DEMO_MAX_PROMPT_LENGTH),
  expiresAt: z.number().int().positive(),
});

const EncryptedDraftSchema = z.object({
  ciphertext: z.string().min(1).max(4_096),
  nonce: z.string().min(1).max(128),
  authTag: z.string().min(1).max(128),
  algorithm: z.literal("aes-256-gcm"),
  encryptionVersion: z.literal(1),
});

const DRAFT_CONTEXT = {
  userId: "anonymous-homepage",
  workflowId: "homepage-demo",
  connectorId: "crazyloops-planner",
  credentialKey: "short-lived-draft",
} as const;

export const HOMEPAGE_DEMO_DRAFT_COOKIE = "crazyloops_demo_draft";
export const HOMEPAGE_DEMO_DRAFT_TTL_SECONDS = 30 * 60;

export function sealHomepageDemoDraft(
  prompt: string,
  now = Date.now(),
  encodedKey?: string,
): string {
  const payload = DraftPayloadSchema.parse({
    version: 1,
    prompt,
    expiresAt: now + HOMEPAGE_DEMO_DRAFT_TTL_SECONDS * 1_000,
  });
  const encrypted = encryptCredential(JSON.stringify(payload), DRAFT_CONTEXT, encodedKey);
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

export function openHomepageDemoDraft(
  token: string,
  now = Date.now(),
  encodedKey?: string,
): string | null {
  try {
    if (!token || token.length > 8_192) return null;
    const encrypted = EncryptedDraftSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    ) as EncryptedCredential;
    const payload = DraftPayloadSchema.parse(
      JSON.parse(decryptCredential(encrypted, DRAFT_CONTEXT, encodedKey)),
    );
    return payload.expiresAt > now ? payload.prompt : null;
  } catch {
    return null;
  }
}
