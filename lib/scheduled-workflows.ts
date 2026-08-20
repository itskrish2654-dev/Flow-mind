import "server-only";

import { executeAiText } from "@/lib/ai-execution";
import { validateWorkflowConnectorConnections } from "@/lib/connectors/subscriptions";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import { completeDurableExecution, createDurableExecution, createExecutionStateHooks, markExecutionRunning } from "@/lib/execution-state";
import { withBoundedRetry } from "@/lib/execution-reliability";
import { captureOperationalError, trackProductEvent } from "@/lib/observability";
import { CompiledWorkflowSchema } from "@/lib/schemas/workflow";
import { SECURITY_LIMITS, enforceRateLimit, enforceUsageQuota, withConcurrencyLease } from "@/lib/security/limits";
import { postTrustedWebhook } from "@/lib/security/outbound-webhook";
import { latestDueOccurrence, type ScheduleDefinition } from "@/lib/scheduling";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { executeWorkflowSteps, validateRequiredSetupInputs } from "@/lib/workflow-execution";

const RECOVERY_WINDOW_MS = 15 * 60_000;

type DueSchedule = {
  id: string;
  user_id: string;
  workflow_id: string;
  workflow_version_id: string;
  schedule_definition: Json;
  timezone: string;
  anchor_at: string;
  next_run_at: string;
};

function stringSetup(value: Json): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function executeClaimedSchedule(input: {
  occurrenceId: string;
  scheduleId: string;
  scheduledFor: Date;
  userId: string;
  workflowId: string;
  workflowVersionId: string;
  timezone: string;
}) {
  const admin = createAdminClient();
  const [{ data: version }, { data: workflow }] = await Promise.all([
    admin.from("workflow_versions").select("compiled_workflow, setup_config").eq("id", input.workflowVersionId).eq("workflow_id", input.workflowId).eq("user_id", input.userId).maybeSingle(),
    admin.from("workflows").select("name, lifecycle_state, public_form_enabled").eq("id", input.workflowId).eq("user_id", input.userId).maybeSingle(),
  ]);
  const parsed = CompiledWorkflowSchema.safeParse(version?.compiled_workflow);
  if (!parsed.success || !workflow || workflow.lifecycle_state !== "active" || !workflow.public_form_enabled) throw new Error("Scheduled workflow is no longer active.");
  const setup = stringSetup(version?.setup_config ?? {});
  const readiness = validateRequiredSetupInputs(parsed.data.steps, setup)
    ?? await validateWorkflowConnectorConnections({ userId: input.userId, setupConfig: setup, steps: parsed.data.steps });
  if (readiness) throw new Error(readiness);
  const inputValues = { ...setup, scheduled_at: input.scheduledFor.toISOString(), schedule_timezone: input.timezone };
  const idempotencyKey = `schedule:${input.scheduleId}:${input.scheduledFor.toISOString()}`;
  const durable = await createDurableExecution(admin, {
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    userId: input.userId,
    triggerType: "schedule",
    triggerMetadata: { scheduleId: input.scheduleId, occurrenceId: input.occurrenceId, scheduledFor: input.scheduledFor.toISOString(), mode: "live" },
    idempotencyKey,
    inputData: { scheduled_at: input.scheduledFor.toISOString(), schedule_timezone: input.timezone },
  });
  await admin.from("workflow_schedule_occurrences").update({ execution_id: durable.id, status: durable.created ? "running" : "duplicate" }).eq("id", input.occurrenceId).eq("user_id", input.userId);
  if (!durable.created) return { executionId: durable.id, duplicate: true, ok: durable.status === "succeeded" };

  await markExecutionRunning(admin, durable.id);
  const result = await withConcurrencyLease("user-execution", [input.userId], 2, () =>
    withConcurrencyLease("workflow-execution", [input.workflowId], 1, async () => {
      await enforceUsageQuota(input.userId, "executions");
      return executeWorkflowSteps({
        userId: input.userId,
        workflowId: input.workflowId,
        workflowName: workflow.name,
        steps: parsed.data.steps,
        inputValues,
        mode: "scheduled",
        idempotencyKey,
        telemetryExecutionId: durable.id,
        stateHooks: createExecutionStateHooks(admin, durable.id, { userId: input.userId, workflowId: input.workflowId, workflowVersionId: input.workflowVersionId }),
        executeAi: async (request) => {
          await enforceRateLimit("ai-execution", [input.userId], SECURITY_LIMITS.ai);
          await enforceUsageQuota(input.userId, "ai_generations");
          await enforceUsageQuota(input.userId, "ai_input_chars", request.instruction.length + request.content.length);
          const ai = await executeAiText(request);
          await enforceUsageQuota(input.userId, "ai_output_tokens", ai.metadata.outputTokens ?? Math.max(1, Math.ceil(ai.text.length / 4)));
          return ai;
        },
        uploadGeneratedDocument: async ({ bytes, stepId }) => {
          await enforceRateLimit("pdf-generation", [input.userId], SECURITY_LIMITS.pdf);
          await enforceUsageQuota(input.userId, "generated_documents");
          await enforceUsageQuota(input.userId, "storage_bytes", bytes.byteLength);
          return withBoundedRetry(() => uploadGeneratedDocument(admin, input.userId, input.workflowId, bytes, `${durable.id}-${stepId}`), { maxAttempts: 2 });
        },
        executeWebhook: (endpoint, payload, stepKey) => postTrustedWebhook(endpoint, payload, stepKey),
      });
    }),
  );
  await completeDurableExecution(admin, durable.id, result);
  await admin.from("workflow_schedule_occurrences").update({ status: result.ok ? "succeeded" : "failed", completed_at: new Date().toISOString(), reason: result.failureReason?.slice(0, 300) ?? null }).eq("id", input.occurrenceId).eq("user_id", input.userId);
  await admin.from("workflow_schedules").update({ last_dispatched_at: new Date().toISOString(), last_error_category: result.ok ? null : "execution_failed" }).eq("id", input.scheduleId).eq("user_id", input.userId);
  await trackProductEvent({ event: "schedule_triggered", userId: input.userId, workflowId: input.workflowId, properties: { status: result.ok ? "succeeded" : "failed" } });
  return { executionId: durable.id, duplicate: false, ok: result.ok };
}

export async function dispatchDueSchedules(limit = 20, now = new Date()) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("workflow_schedules")
    .select("id,user_id,workflow_id,workflow_version_id,schedule_definition,timezone,anchor_at,next_run_at")
    .eq("status", "active").lte("next_run_at", now.toISOString()).order("next_run_at", { ascending: true }).limit(Math.max(1, Math.min(limit, 50)));
  if (error) throw new Error("Due schedules could not be loaded.");
  const metrics = { inspected: 0, claimed: 0, succeeded: 0, failed: 0, missed: 0, duplicate: 0 };
  for (const raw of data ?? []) {
    const row = raw as DueSchedule;
    metrics.inspected += 1;
    try {
      const schedule = row.schedule_definition as unknown as ScheduleDefinition;
      const due = latestDueOccurrence(schedule, new Date(row.next_run_at), now, new Date(row.anchor_at));
      const shouldExecute = now.getTime() - due.scheduledFor.getTime() <= RECOVERY_WINDOW_MS;
      const { data: claims, error: claimError } = await admin.rpc("claim_schedule_occurrence", {
        p_schedule_id: row.id,
        p_expected_next_run_at: row.next_run_at,
        p_scheduled_for: due.scheduledFor.toISOString(),
        p_next_run_at: due.nextRunAt?.toISOString() ?? null,
        p_missed_earlier_count: due.skippedEarlier,
        p_should_execute: shouldExecute,
      });
      const claim = claims?.[0];
      if (claimError || !claim?.claimed || !claim.occurrence_id) { metrics.duplicate += 1; continue; }
      metrics.claimed += 1;
      if (!shouldExecute) { metrics.missed += 1; continue; }
      const outcome = await executeClaimedSchedule({ occurrenceId: claim.occurrence_id, scheduleId: row.id, scheduledFor: due.scheduledFor, userId: claim.user_id, workflowId: claim.workflow_id, workflowVersionId: claim.workflow_version_id, timezone: claim.timezone });
      if (outcome.duplicate) metrics.duplicate += 1;
      else if (outcome.ok) metrics.succeeded += 1;
      else metrics.failed += 1;
    } catch (error) {
      metrics.failed += 1;
      await admin.from("workflow_schedules").update({ last_error_category: "dispatch_failed", updated_at: new Date().toISOString() }).eq("id", row.id).eq("user_id", row.user_id);
      await captureOperationalError({ event: "schedule_dispatch_failed", error, userId: row.user_id, workflowId: row.workflow_id, workflowVersionId: row.workflow_version_id, status: "failed", errorCategory: "schedule_dispatch_failed" });
    }
  }
  return metrics;
}
