import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSafeAiProviderDiagnostics } from "@/lib/ai-execution-core";
import { resolveStepCapabilityId } from "@/lib/capability-registry";
import { classifyExecutionError } from "@/lib/execution-reliability";
import { captureOperationalEvent, trackProductEvent } from "@/lib/observability";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import type { Database, Json } from "@/lib/supabase/types";

export type DurableExecution = {
  id: string;
  created: boolean;
  status: string;
};

export function hashIdempotencyMaterial(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createManualIdempotencyKey(clientRequestId: string): string {
  return `manual:${clientRequestId}`;
}

export function createPublicFormIdempotencyKey(submissionId: string): string {
  return `public-form:${submissionId}`;
}

export async function createDurableExecution(
  admin: SupabaseClient<Database>,
  input: {
    workflowId: string;
    workflowVersionId: string;
    userId: string;
    triggerType: string;
    triggerMetadata?: Record<string, Json | undefined>;
    idempotencyKey: string;
    inputData: Record<string, string>;
  },
): Promise<DurableExecution> {
  const { data, error } = await admin.rpc("create_execution_once", {
    p_workflow_id: input.workflowId,
    p_workflow_version_id: input.workflowVersionId,
    p_user_id: input.userId,
    p_trigger_type: input.triggerType,
    p_trigger_metadata: (input.triggerMetadata ?? {}) as Json,
    p_idempotency_key: input.idempotencyKey,
    p_input_data: input.inputData as Json,
  });
  const row = data?.[0];
  if (error || !row) throw new Error(`Execution could not be queued: ${error?.message ?? "unknown error"}`);
  return { id: row.execution_id, created: row.created, status: row.execution_status };
}

export function createExecutionStateHooks(
  admin: SupabaseClient<Database>,
  executionId: string,
  context?: {
    userId?: string;
    workflowId?: string;
    workflowVersionId?: string;
  },
) {
  const stepStartedAt = new Map<string, number>();
  return {
    onConditionDecision: async (
      step: CompiledWorkflow["steps"][number],
      matched: boolean,
    ) => {
      await trackProductEvent({
        event: matched ? "condition_true" : "condition_false",
        userId: context?.userId,
        workflowId: context?.workflowId,
        properties: { capability: resolveStepCapabilityId(step) ?? "condition.if" },
      });
    },
    onStepStart: async (step: CompiledWorkflow["steps"][number]) => {
      stepStartedAt.set(step.id, Date.now());
      const { error } = await admin
        .from("workflow_execution_steps")
        .update({
          status: "running",
          started_at: new Date().toISOString(),
          completed_at: null,
          error_category: null,
          retryable: null,
          updated_at: new Date().toISOString(),
        })
        .eq("execution_id", executionId)
        .eq("workflow_step_id", step.id)
        .neq("status", "succeeded");
      if (error) throw new Error(`Step state could not be persisted: ${error.message}`);
      await captureOperationalEvent({
        level: "info",
        event: "execution_step_started",
        userId: context?.userId,
        workflowId: context?.workflowId,
        workflowVersionId: context?.workflowVersionId,
        executionId,
        stepId: step.id,
        capability: resolveStepCapabilityId(step) ?? "unknown",
        status: "running",
      });
    },
    onStepFinish: async (
      step: CompiledWorkflow["steps"][number],
      result: {
        status: "succeeded" | "failed" | "skipped";
        message: string;
        providerReferenceId?: string | null;
        metadata?: Record<string, Json | undefined>;
        error?: unknown;
        retryable?: boolean;
      },
    ) => {
      const classification = result.error ? classifyExecutionError(result.error) : null;
      const aiDiagnostics = getSafeAiProviderDiagnostics(result.error);
      const { error } = await admin
        .from("workflow_execution_steps")
        .update({
          status: result.status,
          completed_at: new Date().toISOString(),
          sanitized_output_metadata: {
            message: result.message,
            capabilityId: resolveStepCapabilityId(step) ?? "unknown",
            ...(result.metadata ?? {}),
            ...(aiDiagnostics ? { aiProvider: aiDiagnostics } : {}),
          } as Json,
          provider_reference_id: result.providerReferenceId ?? aiDiagnostics?.requestId ?? null,
          error_category: classification?.category ?? null,
          retryable: result.status !== "succeeded" ? (result.retryable ?? classification?.retryable ?? false) : false,
          updated_at: new Date().toISOString(),
        })
        .eq("execution_id", executionId)
        .eq("workflow_step_id", step.id);
      if (error) throw new Error(`Step result could not be persisted: ${error.message}`);
      const capability = resolveStepCapabilityId(step) ?? "unknown";
      const failed = result.status === "failed";
      const durationMs = Math.max(0, Date.now() - (stepStartedAt.get(step.id) ?? Date.now()));
      await Promise.all([
        captureOperationalEvent({
          level: failed ? "error" : "info",
          event: "execution_step_completed",
          userId: context?.userId,
          workflowId: context?.workflowId,
          workflowVersionId: context?.workflowVersionId,
          executionId,
          stepId: step.id,
          capability,
          durationMs,
          status: result.status,
          errorCategory: classification?.category ?? null,
          metadata: {
            retryable: result.retryable ?? classification?.retryable ?? false,
            ...(aiDiagnostics ? { aiProvider: aiDiagnostics as unknown as Json } : {}),
          },
        }),
        ...(failed && (capability === "ai_text_transform" || capability === "generate_pdf")
          ? [trackProductEvent({
              event: capability === "ai_text_transform" ? "ai_failed" : "pdf_failed",
              userId: context?.userId,
              workflowId: context?.workflowId,
              properties: { capability, failure_category: classification?.category ?? "step_failure" },
            })]
          : []),
        ...(capability === "formatter.transform" && result.status !== "skipped"
          ? [trackProductEvent({
              event: failed ? "formatter_execution_failed" : "formatter_execution_succeeded",
              userId: context?.userId,
              workflowId: context?.workflowId,
              properties: {
                capability,
                operation: typeof result.metadata?.formatterOperation === "string" ? result.metadata.formatterOperation : "unknown",
                duration_ms: durationMs,
                ...(failed ? { failure_category: classification?.category ?? "step_failure" } : {}),
              },
            })]
          : []),
      ]);
      stepStartedAt.delete(step.id);
    },
  };
}

export async function markExecutionRunning(
  admin: SupabaseClient<Database>,
  executionId: string,
): Promise<void> {
  const { error } = await admin.from("workflow_executions").update({
    status: "running",
    started_at: new Date().toISOString(),
  }).eq("id", executionId).eq("status", "queued");
  if (error) throw new Error(`Execution could not start: ${error.message}`);
}

export async function completeDurableExecution(
  admin: SupabaseClient<Database>,
  executionId: string,
  result: {
    ok: boolean;
    inputData: Record<string, string>;
    outputData: unknown;
    failureReason: string | null;
  },
): Promise<void> {
  const output = result.outputData as { status?: string };
  const status = result.ok
    ? "succeeded"
    : output.status === "partial"
      ? "partially_failed"
      : "failed";
  const classification = result.failureReason
    ? classifyExecutionError(new Error(result.failureReason))
    : null;
  const { error } = await admin.from("workflow_executions").update({
    status,
    input_data: result.inputData as Json,
    output_data: result.outputData as Json,
    completed_at: new Date().toISOString(),
    failure_category: classification?.category ?? null,
    sanitized_metadata: {
      retryable: classification?.retryable ?? false,
      failureMessage: result.failureReason,
    },
  }).eq("id", executionId);
  if (error) throw new Error(`Execution result could not be persisted: ${error.message}`);
}
