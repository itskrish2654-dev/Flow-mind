"use server";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { GENERATED_DOCUMENTS_BUCKET } from "@/lib/document-storage";
import { SECURITY_LIMITS, SecurityGateError, enforceRateLimit } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";
import { securityLog } from "@/lib/security/redaction";
import { captureOperationalError, captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeAllUserConnections } from "@/lib/connectors/connection-vault";
import { getSupabaseConfig } from "@/lib/supabase/config";

const DeleteAccountSchema = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
  password: z.string().min(8).max(256),
  captchaToken: z.string().min(1).max(4_096),
});

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; error: string };

async function failJob(jobId: string | null, failureCode: string) {
  if (!jobId) return;
  try {
    await createAdminClient()
      .from("account_deletion_jobs")
      .update({
        state: "failed",
        failure_code: failureCode,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  } catch {
    // The original failure is logged by the caller; never replace it with a
    // false completion response because audit-state recording also failed.
  }
}

async function documentPathsForUser(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const paths: string[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from("generated_document_records")
      .select("storage_path")
      .eq("user_id", userId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error("document_inventory_failed");
    paths.push(...(data ?? []).map((record) => record.storage_path));
    if (!data || data.length < pageSize) break;
  }
  return paths;
}

export async function deleteOwnAccount(input: {
  confirmation: string;
  password: string;
  captchaToken: string;
}): Promise<DeleteAccountResult> {
  const parsed = DeleteAccountSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: input.confirmation !== "DELETE MY ACCOUNT"
        ? "Type DELETE MY ACCOUNT exactly to confirm."
        : "Enter your password and complete the security challenge.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth?.user.email) return { ok: false, error: "Sign in again before deleting your account." };

  try {
    const ip = await getClientIp();
    await enforceRateLimit("account-delete-ip", [ip], SECURITY_LIMITS.accountDeletion);
    await enforceRateLimit("account-delete-user", [auth.user.id], SECURITY_LIMITS.accountDeletion);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SecurityGateError ? error.message : "Account deletion is temporarily unavailable.",
    };
  }

  // Fresh password + CAPTCHA verification is the recent-auth boundary. This
  // stateless client never persists the temporary session.
  const { url, key } = getSupabaseConfig();
  const verifier = createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: verified, error: verificationError } = await verifier.auth.signInWithPassword({
    email: auth.user.email,
    password: parsed.data.password,
    options: { captchaToken: parsed.data.captchaToken },
  });
  if (verificationError || verified.user?.id !== auth.user.id) {
    return {
      ok: false,
      error: /captcha/i.test(`${verificationError?.code ?? ""} ${verificationError?.message ?? ""}`)
        ? "The security challenge could not be verified. Please try again."
        : "Your password could not be verified.",
    };
  }
  await verifier.auth.signOut({ scope: "local" });

  const admin = createAdminClient();
  let jobId: string | null = null;
  try {
    const { data: requestedJob, error: requestError } = await admin.rpc("request_account_deletion", {
      p_user_id: auth.user.id,
    });
    if (requestError || !requestedJob) throw new Error("revocation_failed");
    jobId = requestedJob;

    const paths = await documentPathsForUser(auth.user.id);
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await admin.storage
        .from(GENERATED_DOCUMENTS_BUCKET)
        .remove(paths.slice(index, index + 100));
      if (error) throw new Error("storage_cleanup_failed");
    }

    try { await revokeAllUserConnections(auth.user.id); }
    catch { throw new Error("connector_revocation_failed"); }
    const { data: connectorCleaned, error: connectorCleanupError } = await admin.rpc("cleanup_connector_account_data", { p_user_id: auth.user.id });
    if (connectorCleanupError || !connectorCleaned) throw new Error("connector_cleanup_failed");
    const { data: cleaned, error: cleanupError } = await admin.rpc("cleanup_account_data", {
      p_job_id: jobId,
      p_user_id: auth.user.id,
    });
    if (cleanupError || !cleaned) throw new Error("database_cleanup_failed");

    const { error: identityError } = await admin.auth.admin.deleteUser(auth.user.id);
    if (identityError) throw new Error("identity_cleanup_failed");

    const { error: completionError } = await admin
      .from("account_deletion_jobs")
      .update({
        state: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        failure_code: null,
      })
      .eq("id", jobId)
      .eq("user_id", auth.user.id);
    if (completionError) throw new Error("completion_record_failed");

    await captureOperationalEvent({
      level: "info",
      event: "account_deletion_completed",
      userId: auth.user.id,
      status: "succeeded",
      metadata: { jobId },
    });
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error ? error.message : "account_cleanup_failed";
    await failJob(jobId, code);
    securityLog("Account deletion failed safely", { error, userId: auth.user.id, jobId });
    const reference = await captureOperationalError({
      event: "account_deletion_failed",
      error,
      userId: auth.user.id,
      status: "failed",
      errorCategory: code,
      metadata: { jobId },
    });
    return {
      ok: false,
      error: `Deletion could not be completed. Your public forms remain disabled. Please retry or contact support. Reference: ${reference}`,
    };
  }
}
