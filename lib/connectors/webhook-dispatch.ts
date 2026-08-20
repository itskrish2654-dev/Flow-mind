import "server-only";

import { executeAiText } from "@/lib/ai-execution";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import { completeDurableExecution, createDurableExecution, createExecutionStateHooks, markExecutionRunning } from "@/lib/execution-state";
import { CompiledWorkflowSchema } from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { enforceUsageQuota, withConcurrencyLease } from "@/lib/security/limits";
import { executeWorkflowSteps } from "@/lib/workflow-execution";

function stringInputs(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { payload: JSON.stringify(payload) };
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}

function stringSetup(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function dispatchConnectorReceipt(receiptId: string) {
  const admin = createAdminClient();
  const { data: receipt } = await admin.from("connector_event_receipts").update({ status: "processing" }).eq("id", receiptId).eq("status", "queued").select("*").maybeSingle();
  if (!receipt) return;
  const { data: subscription } = await admin.from("connector_subscriptions").select("user_id, workflow_id, workflow_version_id, status").eq("id", receipt.subscription_id).eq("status", "active").maybeSingle();
  if (!subscription) { await admin.from("connector_event_receipts").update({ status: "failed", processed_at: new Date().toISOString() }).eq("id", receiptId); return; }
  const { data: version } = await admin.from("workflow_versions").select("compiled_workflow, setup_config").eq("id", subscription.workflow_version_id).eq("workflow_id", subscription.workflow_id).eq("user_id", subscription.user_id).maybeSingle();
  const workflow = CompiledWorkflowSchema.safeParse(version?.compiled_workflow);
  const { data: identity } = await admin.from("workflows").select("name, lifecycle_state").eq("id", subscription.workflow_id).eq("user_id", subscription.user_id).maybeSingle();
  if (!workflow.success || !identity || identity.lifecycle_state !== "active") { await admin.from("connector_event_receipts").update({ status: "failed", processed_at: new Date().toISOString() }).eq("id", receiptId); return; }
  const eventInputs = stringInputs(receipt.payload);
  const inputValues = { ...stringSetup(version?.setup_config), ...eventInputs };
  const durable = await createDurableExecution(admin, { workflowId: subscription.workflow_id, workflowVersionId: subscription.workflow_version_id, userId: subscription.user_id, triggerType: "connector_webhook", triggerMetadata: { subscriptionId: receipt.subscription_id }, idempotencyKey: `connector:${receipt.subscription_id}:${receipt.provider_event_key}`, inputData: eventInputs });
  if (!durable.created) { await admin.from("connector_event_receipts").update({ status: "duplicate", execution_id: durable.id, processed_at: new Date().toISOString() }).eq("id", receiptId); return; }
  await admin.from("connector_event_receipts").update({ execution_id: durable.id }).eq("id", receiptId).eq("status", "processing");
  try {
    await markExecutionRunning(admin, durable.id);
    const execution = await withConcurrencyLease("user-execution", [subscription.user_id], 2, () => withConcurrencyLease("workflow-execution", [subscription.workflow_id], 1, async () => {
      await enforceUsageQuota(subscription.user_id, "executions");
      return executeWorkflowSteps({ userId: subscription.user_id, workflowId: subscription.workflow_id, workflowName: identity.name, steps: workflow.data.steps, inputValues, mode: "public-form", idempotencyKey: `connector:${receipt.id}`, telemetryExecutionId: durable.id, workflowVersionId: subscription.workflow_version_id, stateHooks: createExecutionStateHooks(admin, durable.id, { userId: subscription.user_id, workflowId: subscription.workflow_id, workflowVersionId: subscription.workflow_version_id }), executeAi: async (input) => { await enforceUsageQuota(subscription.user_id, "ai_generations"); return executeAiText(input); }, uploadGeneratedDocument: ({ bytes, stepId }) => uploadGeneratedDocument(admin, subscription.user_id, subscription.workflow_id, bytes, `${durable.id}-${stepId}`) });
    }));
    await completeDurableExecution(admin, durable.id, execution);
    await admin.from("connector_event_receipts").update({ status: execution.ok ? "succeeded" : "failed", processed_at: new Date().toISOString() }).eq("id", receiptId);
  } catch {
    await admin.from("workflow_executions").update({ status: "failed", completed_at: new Date().toISOString(), failure_category: "connector_dispatch_failed" }).eq("id", durable.id).eq("user_id", subscription.user_id);
    await admin.from("connector_event_receipts").update({ status: "failed", processed_at: new Date().toISOString() }).eq("id", receiptId);
  }
}

export async function dispatchQueuedConnectorReceipts(limit = 20) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("connector_event_receipts").select("id").eq("status", "queued").order("received_at", { ascending: true }).limit(Math.max(1, Math.min(limit, 50)));
  if (error) throw new Error("Queued connector receipts could not be loaded.");
  const settled = await Promise.allSettled((data ?? []).map((receipt) => dispatchConnectorReceipt(receipt.id)));
  return { inspected: settled.length, failed: settled.filter((result) => result.status === "rejected").length };
}
