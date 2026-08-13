import "server-only";

import { GENERATED_DOCUMENTS_BUCKET } from "@/lib/document-storage";
import { captureOperationalError, captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

const RETRYABLE_FAILURES = new Set([
  "storage_cleanup_failed",
  "database_cleanup_failed",
  "identity_cleanup_failed",
  "completion_record_failed",
  "account_cleanup_failed",
  "interrupted_deletion_job",
]);

async function documentPathsForUser(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const paths: string[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await admin
      .from("generated_document_records")
      .select("storage_path")
      .eq("user_id", userId)
      .range(from, from + 499);
    if (error) throw new Error("document_inventory_failed");
    paths.push(...(data ?? []).map((record) => record.storage_path));
    if (!data || data.length < 500) break;
  }
  return paths;
}

async function retryDeletionJob(job: {
  id: string;
  user_id: string;
  failure_code: string | null;
  retry_count: number;
}) {
  const admin = createAdminClient();
  try {
    const { data: claimed, error: claimError } = await admin
      .from("account_deletion_jobs")
      .update({
        state: "processing",
        retry_count: job.retry_count + 1,
        updated_at: new Date().toISOString(),
        failure_code: null,
      })
      .eq("id", job.id)
      .eq("user_id", job.user_id)
      .eq("state", "failed")
      .eq("retry_count", job.retry_count)
      .select("id")
      .maybeSingle();
    if (claimError) throw new Error("deletion_job_claim_failed");
    if (!claimed) return false;

    const paths = await documentPathsForUser(job.user_id);
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await admin.storage
        .from(GENERATED_DOCUMENTS_BUCKET)
        .remove(paths.slice(index, index + 100));
      if (error) throw new Error("storage_cleanup_failed");
    }

    const { data: connectorCleaned, error: connectorCleanupError } = await admin.rpc("cleanup_connector_account_data", { p_user_id: job.user_id });
    if (connectorCleanupError || !connectorCleaned) throw new Error("connector_cleanup_failed");
    const { data: cleaned, error: cleanupError } = await admin.rpc("cleanup_account_data", {
      p_job_id: job.id,
      p_user_id: job.user_id,
    });
    if (cleanupError || !cleaned) throw new Error("database_cleanup_failed");

    const { data: identity } = await admin.auth.admin.getUserById(job.user_id);
    if (identity.user) {
      const { error: identityError } = await admin.auth.admin.deleteUser(job.user_id);
      if (identityError) throw new Error("identity_cleanup_failed");
    }

    const { error: completionError } = await admin.from("account_deletion_jobs").update({
      state: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      failure_code: null,
    }).eq("id", job.id).eq("user_id", job.user_id);
    if (completionError) throw new Error("completion_record_failed");

    await captureOperationalEvent({
      level: "info",
      event: "account_deletion_reconciled",
      userId: job.user_id,
      status: "succeeded",
      metadata: { jobId: job.id },
    });
    return true;
  } catch (error) {
    const failureCode = error instanceof Error ? error.message : "account_cleanup_failed";
    await admin.from("account_deletion_jobs").update({
      state: "failed",
      failure_code: failureCode,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("user_id", job.user_id);
    await captureOperationalError({
      event: "account_deletion_reconciliation_failed",
      error,
      userId: job.user_id,
      status: "failed",
      errorCategory: failureCode,
      metadata: { jobId: job.id },
    });
    return false;
  }
}

export async function reconcileFailedAccountDeletions(limit = 5): Promise<{
  inspected: number;
  retried: number;
  succeeded: number;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("account_deletion_jobs")
    .select("id, user_id, failure_code, retry_count")
    .eq("state", "failed")
    .lt("retry_count", 5)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 10)));
  if (error) throw new Error("deletion_job_inventory_failed");

  const retryable = (data ?? []).filter((job) =>
    !job.failure_code || RETRYABLE_FAILURES.has(job.failure_code),
  );
  let succeeded = 0;
  for (const job of retryable) {
    if (await retryDeletionJob(job)) succeeded += 1;
  }
  return { inspected: data?.length ?? 0, retried: retryable.length, succeeded };
}
