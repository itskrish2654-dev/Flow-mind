"use server";

import { z } from "zod";

import { executeAiText } from "@/lib/ai-execution";
import { getAuthenticatedContext } from "@/lib/auth";
import { assessWorkflowCapabilities } from "@/lib/capability-registry";
import { validateWorkflowConnectorConnections } from "@/lib/connectors/subscriptions";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import {
  completeDurableExecution,
  createDurableExecution,
  createExecutionStateHooks,
  createManualIdempotencyKey,
  markExecutionRunning,
} from "@/lib/execution-state";
import { withBoundedRetry } from "@/lib/execution-reliability";
import {
  CompiledWorkflowSchema,
  WorkflowStepSchema,
  type CompiledWorkflow,
} from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SECURITY_LIMITS,
  SecurityGateError,
  enforceRateLimit,
  enforceUsageQuota,
  withConcurrencyLease,
} from "@/lib/security/limits";
import { postTrustedWebhook } from "@/lib/security/outbound-webhook";
import { securityLog } from "@/lib/security/redaction";
import { isSensitiveFieldName } from "@/lib/security/redaction";
import { captureOperationalError, captureOperationalEvent, trackProductEvent } from "@/lib/observability";
import {
  createImmutableWorkflowVersion,
  loadWorkflowSnapshot,
  sanitizeSetupConfig,
} from "@/lib/workflow-versioning";
import {
  executeWorkflowSteps,
  validateRequiredSetupInputs,
  type ExecutionLog,
} from "@/lib/workflow-execution";

export type TestExecutionLog = ExecutionLog;

export type TestWorkflowResult =
  | {
      ok: true;
      logs: TestExecutionLog[];
      delivered: boolean;
      executionId: string;
    }
  | {
      ok: false;
      error: string;
      logs?: TestExecutionLog[];
      executionId?: string;
    };

type InputValues = Record<string, string>;

const TestRequestSchema = z.object({
  workflowId: z.string().uuid(),
  steps: z.array(WorkflowStepSchema).min(1).max(10),
  inputValues: z.record(z.string(), z.string().max(10_000)).refine(
    (values) => Object.keys(values).length <= 100,
    "Too many setup values were provided.",
  ),
  idempotencyKey: z.string().uuid(),
});

export async function runTestWorkflow(
  workflowId: string,
  steps: CompiledWorkflow["steps"],
  inputValues: InputValues,
  idempotencyKey = crypto.randomUUID(),
): Promise<TestWorkflowResult> {
  const request = TestRequestSchema.safeParse({ workflowId, steps, inputValues, idempotencyKey });
  if (!request.success) {
    return {
      ok: false,
      error: "The test setup is incomplete or contains an invalid value.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const executionStartedAt = Date.now();

  const admin = createAdminClient();
  let snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id);
  if (!snapshot || snapshot.lifecycleState !== "active") {
    return { ok: false, error: "This automation is unavailable or disabled." };
  }
  const savedWorkflow = CompiledWorkflowSchema.safeParse(snapshot.workflow);
  if (!savedWorkflow.success) {
    return { ok: false, error: "This automation needs to be created again." };
  }

  const hasUnavailableCapability = assessWorkflowCapabilities(
    savedWorkflow.data.steps,
    "test",
  ).some(({ assessment }) => !assessment.available);
  if (!hasUnavailableCapability) {
    const validationError = validateRequiredSetupInputs(
      savedWorkflow.data.steps,
      request.data.inputValues,
    );
    if (validationError) return { ok: false, error: validationError };
    const connectorReadiness = await validateWorkflowConnectorConnections({
      userId: auth.user.id,
      setupConfig: request.data.inputValues,
      steps: savedWorkflow.data.steps,
    });
    if (connectorReadiness) return { ok: false, error: connectorReadiness };
  }

  const authoritativeSetup = sanitizeSetupConfig(request.data.inputValues, isSensitiveFieldName);
  const normalize = (value: Record<string, string>) => JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
  if (normalize(authoritativeSetup) !== normalize(snapshot.setupConfig)) {
    try {
      await createImmutableWorkflowVersion(admin, {
        workflowId: snapshot.workflowId,
        userId: auth.user.id,
        expectedVersionId: snapshot.versionId,
        workflow: snapshot.workflow,
        setupConfig: authoritativeSetup,
        scope: "setup",
        summary: "Updated non-secret workflow setup before execution.",
      });
      snapshot = (await loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id)) ?? snapshot;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Workflow setup could not be saved." };
    }
  }

  let durable;
  try {
    durable = await createDurableExecution(admin, {
      workflowId: snapshot.workflowId,
      workflowVersionId: snapshot.versionId,
      userId: auth.user.id,
      triggerType: "manual_test",
      triggerMetadata: { mode: "test" },
      idempotencyKey: createManualIdempotencyKey(request.data.idempotencyKey),
      inputData: authoritativeSetup,
    });
  } catch (error) {
    securityLog("Durable execution creation failed", { error, workflowId });
    return { ok: false, error: "The execution could not be safely queued." };
  }
  if (!durable.created) {
    const { data: existing } = await admin
      .from("workflow_executions")
      .select("status, output_data")
      .eq("id", durable.id)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    const output = existing?.output_data as { logs?: ExecutionLog[]; delivered?: boolean } | null;
    return existing?.status === "succeeded"
      ? { ok: true, logs: output?.logs ?? [], delivered: output?.delivered === true, executionId: durable.id }
      : { ok: false, error: existing?.status === "running" || existing?.status === "queued" ? "This execution is already in progress." : "This request already has an execution record.", executionId: durable.id, logs: output?.logs };
  }

  await Promise.all([
    trackProductEvent({
      event: "execution_started",
      userId: auth.user.id,
      workflowId: request.data.workflowId,
      properties: { trigger_type: "manual_test", retry: false },
    }),
    captureOperationalEvent({
      level: "info",
      event: "execution_started",
      userId: auth.user.id,
      workflowId: request.data.workflowId,
      workflowVersionId: snapshot.versionId,
      executionId: durable.id,
      status: "running",
    }),
  ]);

  let execution: Awaited<ReturnType<typeof executeWorkflowSteps>>;
  try {
    await enforceRateLimit(
      "test-execution",
      [auth.user.id, request.data.workflowId],
      SECURITY_LIMITS.testExecution,
    );
    await markExecutionRunning(admin, durable.id);
    execution = await withConcurrencyLease(
      "user-execution",
      [auth.user.id],
      2,
      () => withConcurrencyLease(
        "workflow-execution",
        [request.data.workflowId],
        1,
        async () => {
          // Busy requests stop before this reservation and consume no usage.
          // If quota fails, both nested leases are released by their finally blocks.
          await enforceUsageQuota(auth.user.id, "executions");
          return executeWorkflowSteps({
            userId: auth.user.id,
            workflowId: request.data.workflowId,
            workflowName: snapshot.name,
            steps: snapshot.workflow.steps,
            inputValues: request.data.inputValues,
            mode: "test",
            executeAi: async (input) => {
              await enforceRateLimit("ai-execution", [auth.user.id], SECURITY_LIMITS.ai);
              await enforceUsageQuota(auth.user.id, "ai_generations");
              await enforceUsageQuota(
                auth.user.id,
                "ai_input_chars",
                input.instruction.length + input.content.length,
              );
              const result = await withBoundedRetry(() => executeAiText(input), { maxAttempts: 2 });
              await enforceUsageQuota(
                auth.user.id,
                "ai_output_tokens",
                result.metadata.outputTokens ?? Math.max(1, Math.ceil(result.text.length / 4)),
              );
              return result;
            },
            uploadGeneratedDocument: async ({ bytes, stepId }) => {
              await enforceRateLimit("pdf-generation", [auth.user.id], SECURITY_LIMITS.pdf);
              await enforceUsageQuota(auth.user.id, "generated_documents");
              await enforceUsageQuota(auth.user.id, "uploads");
              await enforceUsageQuota(auth.user.id, "storage_bytes", bytes.byteLength);
              return withBoundedRetry(() => uploadGeneratedDocument(
                admin, auth.user.id, request.data.workflowId, bytes, `${durable.id}-${stepId}`,
              ), { maxAttempts: 2 });
            },
            executeWebhook: async (endpoint, payload, stepIdempotencyKey) => {
              const host = new URL(endpoint).hostname.toLowerCase();
              await enforceRateLimit("webhook-user", [auth.user.id], SECURITY_LIMITS.webhookUser);
              await enforceRateLimit("webhook-destination", [host], SECURITY_LIMITS.webhookDestination);
              return postTrustedWebhook(endpoint, payload, stepIdempotencyKey);
            },
            idempotencyKey: createManualIdempotencyKey(request.data.idempotencyKey),
            stateHooks: createExecutionStateHooks(admin, durable.id, {
              userId: auth.user.id,
              workflowId: request.data.workflowId,
              workflowVersionId: snapshot.versionId,
            }),
          });
        },
      ),
    );
  } catch (error: unknown) {
    securityLog("Workflow execution failed", {
      error,
      workflowId: request.data.workflowId,
      userId: auth.user.id,
    });
    await admin.from("workflow_executions").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      failure_category: error instanceof SecurityGateError ? error.code.toLowerCase() : "execution_error",
      sanitized_metadata: { message: error instanceof Error ? error.message : "Execution failed." },
    }).eq("id", durable.id);
    await Promise.all([
      trackProductEvent({
        event: error instanceof SecurityGateError && error.code === "QUOTA_EXCEEDED"
          ? "quota_reached"
          : "execution_failed",
        userId: auth.user.id,
        workflowId: request.data.workflowId,
        properties: {
          trigger_type: "manual_test",
          failure_category: error instanceof SecurityGateError ? error.code : "execution_error",
        },
      }),
      captureOperationalError({
        event: "execution_failed",
        error,
        userId: auth.user.id,
        workflowId: request.data.workflowId,
        workflowVersionId: snapshot.versionId,
        executionId: durable.id,
        durationMs: Date.now() - executionStartedAt,
        status: "failed",
        errorCategory: error instanceof SecurityGateError ? error.code.toLowerCase() : "execution_error",
      }),
    ]);
    return {
      ok: false,
      error:
        error instanceof SecurityGateError
          ? error.message
          : "The workflow could not complete this test safely.",
      executionId: durable.id,
    };
  }

  try {
    await completeDurableExecution(admin, durable.id, execution);
  } catch (executionError) {
    securityLog("Execution persistence failed", {
      error: executionError,
      executionId: durable.id,
    });
    return {
      ok: false,
      error: "The execution is durable, but its final state needs reconciliation.",
      executionId: durable.id,
    };
  }

  if (!execution.ok) {
    await Promise.all([
      trackProductEvent({
        event: execution.outputData.status === "partial" ? "execution_partially_failed" : "execution_failed",
        userId: auth.user.id,
        workflowId: request.data.workflowId,
        properties: {
          trigger_type: "manual_test",
          failure_category: "step_failure",
        },
      }),
      captureOperationalEvent({
        level: "error",
        event: "execution_completed",
        userId: auth.user.id,
        workflowId: request.data.workflowId,
        workflowVersionId: snapshot.versionId,
        executionId: durable.id,
        durationMs: Date.now() - executionStartedAt,
        status: execution.outputData.status === "partial" ? "partially_failed" : "failed",
        errorCategory: "step_failure",
      }),
    ]);
    return {
      ok: false,
      error: execution.failureReason ?? "The workflow could not complete this test.",
      logs: execution.logs,
      executionId: durable.id,
    };
  }

  await Promise.all([
    trackProductEvent({
      event: "execution_succeeded",
      userId: auth.user.id,
      workflowId: request.data.workflowId,
      properties: { trigger_type: "manual_test", duration_ms: Date.now() - executionStartedAt },
    }),
    captureOperationalEvent({
      level: "info",
      event: "execution_completed",
      userId: auth.user.id,
      workflowId: request.data.workflowId,
      workflowVersionId: snapshot.versionId,
      executionId: durable.id,
      durationMs: Date.now() - executionStartedAt,
      status: "succeeded",
    }),
  ]);

  return {
    ok: true,
    logs: execution.logs,
    delivered: execution.delivered,
    executionId: durable.id,
  };
}

export async function retryWorkflowExecution(executionId: string): Promise<TestWorkflowResult> {
  const parsedId = z.string().uuid().safeParse(executionId);
  if (!parsedId.success) return { ok: false, error: "Execution not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();
  await trackProductEvent({
    event: "execution_retry_attempted",
    userId: auth.user.id,
    properties: { retry: true },
  });

  const { data: existing, error: existingError } = await admin
    .from("workflow_executions")
    .select("id, workflow_id, workflow_version_id, idempotency_key, input_data, output_data, status")
    .eq("id", parsedId.data)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (existingError || !existing?.workflow_version_id) {
    return { ok: false, error: "This execution cannot be retried because its exact workflow version is unavailable." };
  }
  const { data: version } = await admin.from("workflow_versions")
    .select("compiled_workflow")
    .eq("id", existing.workflow_version_id)
    .eq("workflow_id", existing.workflow_id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const workflow = CompiledWorkflowSchema.safeParse(version?.compiled_workflow);
  if (!workflow.success) return { ok: false, error: "The immutable workflow snapshot is unavailable." };

  const { data: stepRows } = await admin.from("workflow_execution_steps")
    .select("workflow_step_id, status")
    .eq("execution_id", existing.id);
  const completedStepIds = new Set(
    (stepRows ?? []).filter((step) => step.status === "succeeded").map((step) => step.workflow_step_id),
  );
  const { data: claimed, error: claimError } = await admin.rpc("claim_execution_retry", {
    p_execution_id: existing.id,
    p_user_id: auth.user.id,
  });
  if (claimError || !claimed) {
    return { ok: false, error: "No safely retryable failed step is available. Completed or ambiguous external steps will not be repeated." };
  }

  const inputValues = existing.input_data && typeof existing.input_data === "object" && !Array.isArray(existing.input_data)
    ? Object.fromEntries(Object.entries(existing.input_data).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  const priorOutput = existing.output_data && typeof existing.output_data === "object" && !Array.isArray(existing.output_data)
    ? existing.output_data
    : {};
  const priorAiResult = typeof priorOutput.ai_result === "string" ? priorOutput.ai_result : null;
  const priorDocuments = Array.isArray(priorOutput.documents)
    ? priorOutput.documents.flatMap((document) => {
        if (!document || typeof document !== "object" || Array.isArray(document)) return [];
        return typeof document.id === "string" && typeof document.filename === "string"
          ? [{ id: document.id, filename: document.filename }]
          : [];
      })
    : [];
  const { data: identity } = await admin.from("workflows").select("name, lifecycle_state")
    .eq("id", existing.workflow_id).eq("user_id", auth.user.id).maybeSingle();
  if (!identity || identity.lifecycle_state === "archived") {
    return { ok: false, error: "Archived workflows cannot be retried." };
  }

  try {
    await markExecutionRunning(admin, existing.id);
    const execution = await withConcurrencyLease("user-execution", [auth.user.id], 2, () =>
      withConcurrencyLease("workflow-execution", [existing.workflow_id], 1, async () => {
        await enforceUsageQuota(auth.user.id, "executions");
        return executeWorkflowSteps({
          userId: auth.user.id,
          workflowId: existing.workflow_id,
          workflowName: identity.name,
          steps: workflow.data.steps,
          inputValues,
          mode: "test",
          completedStepIds,
          resumeState: { aiResult: priorAiResult, documents: priorDocuments },
          idempotencyKey: existing.idempotency_key,
          stateHooks: createExecutionStateHooks(admin, existing.id, {
            userId: auth.user.id,
            workflowId: existing.workflow_id,
            workflowVersionId: existing.workflow_version_id ?? undefined,
          }),
          executeAi: async (input) => {
            await enforceRateLimit("ai-execution", [auth.user.id], SECURITY_LIMITS.ai);
            await enforceUsageQuota(auth.user.id, "ai_generations");
            const result = await withBoundedRetry(() => executeAiText(input), { maxAttempts: 2 });
            await enforceUsageQuota(auth.user.id, "ai_input_chars", input.instruction.length + input.content.length);
            await enforceUsageQuota(auth.user.id, "ai_output_tokens", result.metadata.outputTokens ?? Math.max(1, Math.ceil(result.text.length / 4)));
            return result;
          },
          uploadGeneratedDocument: async ({ bytes, stepId }) => withBoundedRetry(() =>
            uploadGeneratedDocument(admin, auth.user.id, existing.workflow_id, bytes, `${existing.id}-${stepId}`),
          { maxAttempts: 2 }),
          executeWebhook: async (endpoint, payload, stepIdempotencyKey) =>
            postTrustedWebhook(endpoint, payload, stepIdempotencyKey),
        });
      }),
    );
    await completeDurableExecution(admin, existing.id, execution);
    if (execution.ok) {
      await trackProductEvent({
        event: "execution_retry_succeeded",
        userId: auth.user.id,
        workflowId: existing.workflow_id,
        properties: { retry: true, success: true },
      });
    }
    return execution.ok
      ? { ok: true, logs: execution.logs, delivered: execution.delivered, executionId: existing.id }
      : { ok: false, error: execution.failureReason ?? "Retry failed.", logs: execution.logs, executionId: existing.id };
  } catch (error) {
    await admin.from("workflow_executions").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      failure_category: "retry_failed",
      sanitized_metadata: { message: error instanceof Error ? error.message : "Retry failed." },
    }).eq("id", existing.id).eq("user_id", auth.user.id);
    return { ok: false, error: error instanceof SecurityGateError ? error.message : "The retry could not complete safely.", executionId: existing.id };
  }
}
