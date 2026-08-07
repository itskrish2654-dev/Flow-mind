"use server";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import {
  CompiledWorkflowSchema,
  WorkflowStepSchema,
  type CompiledWorkflow,
} from "@/lib/schemas/workflow";
import type { Json } from "@/lib/supabase/types";
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
  | { ok: false; error: string };

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

  const validationError = validateRequiredSetupInputs(
    savedWorkflow.data.steps,
    request.data.inputValues,
  );
  if (validationError) return { ok: false, error: validationError };

  const execution = await executeWorkflowSteps({
    workflowId: request.data.workflowId,
    workflowName: ownedWorkflow.name,
    steps: savedWorkflow.data.steps,
    inputValues: request.data.inputValues,
    mode: "test",
  });

  const { data: savedExecution, error: executionError } = await auth.supabase
    .from("workflow_executions")
    .insert({
      workflow_id: request.data.workflowId,
      input_data: execution.inputData as Json,
      output_data: execution.outputData as Json,
    })
    .select("id")
    .single();

  if (executionError || !savedExecution) {
    console.error("Supabase execution insert failed", {
      code: executionError?.code,
      message: executionError?.message,
    });
    return {
      ok: false,
      error: "The workflow ran, but its result could not be saved.",
    };
  }

  return {
    ok: true,
    logs: execution.logs,
    delivered: execution.delivered,
    executionId: savedExecution.id,
  };
}
