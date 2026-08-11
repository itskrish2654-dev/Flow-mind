"use server";

import { z } from "zod";

import { executeAiText } from "@/lib/ai-execution";
import { getAuthenticatedContext } from "@/lib/auth";
import { assessWorkflowCapabilities } from "@/lib/capability-registry";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import {
  CompiledWorkflowSchema,
  WorkflowStepSchema,
  type CompiledWorkflow,
} from "@/lib/schemas/workflow";
import type { Json } from "@/lib/supabase/types";
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
});

export async function runTestWorkflow(
  workflowId: string,
  steps: CompiledWorkflow["steps"],
  inputValues: InputValues,
): Promise<TestWorkflowResult> {
  const request = TestRequestSchema.safeParse({ workflowId, steps, inputValues });
  if (!request.success) {
    return {
      ok: false,
      error: "The test setup is incomplete or contains an invalid value.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data: ownedWorkflow, error: ownershipError } = await auth.supabase
    .from("workflows")
    .select("name, compiled_steps")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (ownershipError || !ownedWorkflow?.compiled_steps) {
    return { ok: false, error: "Unauthorized" };
  }

  const savedWorkflow = CompiledWorkflowSchema.safeParse(
    ownedWorkflow.compiled_steps,
  );
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
  }

  let execution: Awaited<ReturnType<typeof executeWorkflowSteps>>;
  try {
    await enforceRateLimit(
      "test-execution",
      [auth.user.id, request.data.workflowId],
      SECURITY_LIMITS.testExecution,
    );
    const admin = createAdminClient();
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
            workflowId: request.data.workflowId,
            workflowName: ownedWorkflow.name,
            steps: savedWorkflow.data.steps,
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
              const result = await executeAiText(input);
              await enforceUsageQuota(
                auth.user.id,
                "ai_output_tokens",
                result.metadata.outputTokens ?? Math.max(1, Math.ceil(result.text.length / 4)),
              );
              return result;
            },
            uploadGeneratedDocument: async ({ bytes }) => {
              await enforceRateLimit("pdf-generation", [auth.user.id], SECURITY_LIMITS.pdf);
              await enforceUsageQuota(auth.user.id, "generated_documents");
              await enforceUsageQuota(auth.user.id, "uploads");
              await enforceUsageQuota(auth.user.id, "storage_bytes", bytes.byteLength);
              return uploadGeneratedDocument(
                admin,
                auth.user.id,
                request.data.workflowId,
                bytes,
              );
            },
            executeWebhook: async (endpoint, payload) => {
              const host = new URL(endpoint).hostname.toLowerCase();
              await enforceRateLimit("webhook-user", [auth.user.id], SECURITY_LIMITS.webhookUser);
              await enforceRateLimit("webhook-destination", [host], SECURITY_LIMITS.webhookDestination);
              return postTrustedWebhook(endpoint, payload);
            },
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
    return {
      ok: false,
      error:
        error instanceof SecurityGateError
          ? error.message
          : "The workflow could not complete this test safely.",
    };
  }

  const admin = createAdminClient();
  const { data: savedExecution, error: executionError } = await admin
    .from("workflow_executions")
    .insert({
      workflow_id: request.data.workflowId,
      input_data: execution.inputData as Json,
      output_data: execution.outputData as Json,
    })
    .select("id")
    .single();

  if (executionError || !savedExecution) {
    securityLog("Execution persistence failed", {
      code: executionError?.code,
      message: executionError?.message,
    });
    return {
      ok: false,
      error: "The workflow ran, but its result could not be saved.",
    };
  }

  if (!execution.ok) {
    return {
      ok: false,
      error: execution.failureReason ?? "The workflow could not complete this test.",
      logs: execution.logs,
      executionId: savedExecution.id,
    };
  }

  return {
    ok: true,
    logs: execution.logs,
    delivered: execution.delivered,
    executionId: savedExecution.id,
  };
}
