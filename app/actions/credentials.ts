"use server";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { captureOperationalError } from "@/lib/observability";
import {
  deleteCredential as deleteVaultCredential,
  listCredentialMetadata,
  storeCredential,
  type CredentialMetadata,
} from "@/lib/security/credential-vault";
import { securityLog } from "@/lib/security/redaction";

const CredentialIdentitySchema = z.object({
  workflowId: z.string().uuid(),
  connectorId: z.string().trim().min(1).max(80).regex(/^[a-z0-9_.-]+$/i),
  credentialKey: z.string().trim().min(1).max(80).regex(/^[a-z0-9_-]+$/i),
});

async function ownsWorkflow(userId: string, workflowId: string) {
  const auth = await getAuthenticatedContext();
  if (!auth || auth.user.id !== userId) return false;
  const { data } = await auth.supabase
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

export async function saveWorkflowCredential(input: {
  workflowId: string;
  connectorId: string;
  credentialKey: string;
  credentialType: "api_key" | "oauth_token" | "password" | "webhook_secret";
  secret: string;
}): Promise<{ ok: true; credential: CredentialMetadata } | { ok: false; error: string }> {
  const parsed = CredentialIdentitySchema.extend({
    credentialType: z.enum(["api_key", "oauth_token", "password", "webhook_secret"]),
    secret: z.string().min(1).max(10_000),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Credential details are invalid." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  if (!(await ownsWorkflow(auth.user.id, parsed.data.workflowId))) {
    return { ok: false, error: "Workflow not found." };
  }
  try {
    const credential = await storeCredential(
      {
        userId: auth.user.id,
        workflowId: parsed.data.workflowId,
        connectorId: parsed.data.connectorId,
        credentialKey: parsed.data.credentialKey,
      },
      parsed.data.credentialType,
      parsed.data.secret,
    );
    return { ok: true, credential };
  } catch (error) {
    securityLog("Credential save failed", { error, workflowId: parsed.data.workflowId });
    await captureOperationalError({
      event: "credential_vault_failed",
      error,
      userId: auth.user.id,
      workflowId: parsed.data.workflowId,
      errorCategory: "credential_storage",
      status: "failed",
    });
    return { ok: false, error: "Credential could not be stored securely." };
  }
}

export async function getWorkflowCredentialMetadata(
  workflowId: string,
): Promise<{ ok: true; credentials: CredentialMetadata[] } | { ok: false; error: string }> {
  const parsed = z.string().uuid().safeParse(workflowId);
  if (!parsed.success) return { ok: false, error: "Workflow not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  if (!(await ownsWorkflow(auth.user.id, parsed.data))) {
    return { ok: false, error: "Workflow not found." };
  }
  try {
    return {
      ok: true,
      credentials: await listCredentialMetadata(auth.user.id, parsed.data),
    };
  } catch (error) {
    await captureOperationalError({
      event: "credential_vault_failed",
      error,
      userId: auth.user.id,
      workflowId: parsed.data,
      errorCategory: "credential_metadata",
      status: "failed",
    });
    return { ok: false, error: "Credential status could not be loaded." };
  }
}

export async function revokeWorkflowCredential(input: {
  workflowId: string;
  connectorId: string;
  credentialKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = CredentialIdentitySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Credential details are invalid." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  if (!(await ownsWorkflow(auth.user.id, parsed.data.workflowId))) {
    return { ok: false, error: "Workflow not found." };
  }
  try {
    await deleteVaultCredential({
      userId: auth.user.id,
      workflowId: parsed.data.workflowId,
      connectorId: parsed.data.connectorId,
      credentialKey: parsed.data.credentialKey,
    });
    return { ok: true };
  } catch (error) {
    await captureOperationalError({
      event: "credential_vault_failed",
      error,
      userId: auth.user.id,
      workflowId: parsed.data.workflowId,
      errorCategory: "credential_deletion",
      status: "failed",
    });
    return { ok: false, error: "Credential could not be removed." };
  }
}
