import type {
  AiExecutionMetadata,
  AiTextExecutor,
} from "@/lib/ai-execution-core";
import {
  assessWorkflowCapabilities,
  resolveStepCapabilityId,
} from "@/lib/capability-registry";
import {
  generatePdfBuffer,
  populateDocumentTemplate,
  type DocumentVariables,
} from "@/lib/pdf-document";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { postTrustedWebhook } from "@/lib/security/outbound-webhook";
import { securityLog } from "@/lib/security/redaction";

export type StepExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "unsupported";

export type ExecutionLog = {
  icon: string;
  message: string;
  stepId?: string;
  status?: StepExecutionStatus;
};

export type StepExecutionRecord = {
  stepId: string;
  capabilityId: string;
  title: string;
  status: StepExecutionStatus;
  message: string;
};

type WorkflowStep = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;

export type GeneratedDocumentUpload = (input: {
  bytes: Uint8Array;
  stepId: string;
}) => Promise<{ id: string; path: string; filename: string }>;

export type TrustedWebhookExecutor = (
  endpoint: string,
  payload: unknown,
  idempotencyKey?: string,
) => Promise<{ status: number; referenceId?: string }>;

export type ExecutionStateHooks = {
  onStepStart?: (step: WorkflowStep) => Promise<void>;
  onStepFinish?: (
    step: WorkflowStep,
    result: {
      status: "succeeded" | "failed" | "skipped";
      message: string;
      providerReferenceId?: string | null;
      metadata?: Record<string, string | number | boolean | null>;
      error?: unknown;
      retryable?: boolean;
    },
  ) => Promise<void>;
};

export type WorkflowExecutionResult = {
  ok: boolean;
  failureReason: string | null;
  logs: ExecutionLog[];
  delivered: boolean;
  inputData: Record<string, string>;
  outputData: {
    status: "succeeded" | "failed" | "partial";
    summary: string;
    ai_result: string | null;
    ai_metadata: Array<AiExecutionMetadata & { stepId: string }>;
    steps: StepExecutionRecord[];
    logs: ExecutionLog[];
    delivered: boolean;
    pdf_url: null;
    documents: Array<{ id: string; filename: string }>;
  };
};

export function validateRequiredSetupInputs(
  steps: WorkflowStep[],
  inputValues: InputValues,
): string | null {
  for (const step of steps) {
    if (["public_form_trigger", "webhook_trigger", "store_data"].includes(step.type)) {
      continue;
    }

    if (step.type === "generate_pdf") {
      const template = (
        inputValues[`${step.id}-document_template`] ??
        inputValues.document_template ??
        step.config?.documentTemplate ??
        ""
      ).trim();
      if (!template) return "Document Template is required before running a test.";
      continue;
    }

    if (["webhook_post", "http_request"].includes(step.type)) {
      if (!step.config?.endpoint?.trim()) {
        return "Save a trusted webhook destination before running a test.";
      }
      continue;
    }

    for (const input of step.inputsRequired ?? []) {
      const value = (
        inputValues[`${step.id}-${input.key}`] ??
        inputValues[input.key] ??
        input.value ??
        ""
      ).trim();
      if (!value) return `${input.label} is required before running a test.`;
      if (input.type === "url") {
        try {
          const parsed = new URL(value);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return `${input.label} must be a valid http or https link.`;
          }
        } catch {
          return `${input.label} must be a valid link.`;
        }
      }
    }
  }
  return null;
}

function safeInputData(
  steps: WorkflowStep[],
  inputValues: InputValues,
): Record<string, string> {
  const secretKeys = new Set(
    steps.flatMap((step) =>
      (step.inputsRequired ?? [])
        .filter((input) => input.type === "secret")
        .flatMap((input) => [input.key, `${step.id}-${input.key}`]),
    ),
  );
  return Object.fromEntries(
    Object.entries(inputValues).filter(
      ([key, value]) =>
        !secretKeys.has(key) &&
        !key.endsWith("document_template") &&
        value.trim().length > 0,
    ),
  );
}

function executionVariables(
  steps: WorkflowStep[],
  inputValues: InputValues,
  inputData: Record<string, string>,
  workflowId: string,
  workflowName: string,
): DocumentVariables {
  const variables: DocumentVariables = {
    ...inputData,
    trigger: { ...inputData },
    workflow: { id: workflowId, name: workflowName },
  };
  for (const step of steps) {
    for (const input of step.inputsRequired ?? []) {
      if (input.type === "secret") continue;
      const value =
        inputValues[`${step.id}-${input.key}`] ??
        inputValues[input.key] ??
        input.value;
      if (value !== undefined) variables[input.key] = value;
    }
  }
  return variables;
}

export async function executeWorkflowSteps({
  workflowId,
  workflowName,
  steps,
  inputValues,
  mode,
  uploadGeneratedDocument,
  executeAi,
  executeWebhook = postTrustedWebhook,
  idempotencyKey,
  stateHooks,
  completedStepIds = new Set<string>(),
  resumeState,
}: {
  workflowId: string;
  workflowName: string;
  steps: WorkflowStep[];
  inputValues: InputValues;
  mode: "test" | "public-form";
  uploadGeneratedDocument?: GeneratedDocumentUpload;
  executeAi?: AiTextExecutor;
  executeWebhook?: TrustedWebhookExecutor;
  idempotencyKey?: string;
  stateHooks?: ExecutionStateHooks;
  completedStepIds?: Set<string>;
  resumeState?: {
    aiResult?: string | null;
    documents?: Array<{ id: string; filename: string }>;
  };
}): Promise<WorkflowExecutionResult> {
  const logs: ExecutionLog[] = [];
  const records: StepExecutionRecord[] = [];
  const inputData = safeInputData(steps, inputValues);
  const documents: Array<{ id: string; filename: string }> = [...(resumeState?.documents ?? [])];
  const aiMetadata: Array<AiExecutionMetadata & { stepId: string }> = [];
  const variables = executionVariables(
    steps,
    inputValues,
    inputData,
    workflowId,
    workflowName,
  );
  let delivered = false;
  let aiResult: string | null = resumeState?.aiResult ?? null;
  let failureReason: string | null = null;
  if (aiResult) {
    variables.ai_result = aiResult;
    variables.ai_summary = aiResult;
    variables.ai = { result: aiResult, summary: aiResult };
  }

  const finish = (): WorkflowExecutionResult => {
    const succeeded = records.filter((record) => record.status === "succeeded").length;
    const failed = records.some((record) =>
      ["failed", "unsupported", "skipped"].includes(record.status),
    );
    const status = failed ? (succeeded > 0 ? "partial" : "failed") : "succeeded";
    return {
      ok: !failed,
      failureReason,
      logs,
      delivered,
      inputData,
      outputData: {
        status,
        summary: failureReason
          ? `${workflowName} stopped: ${failureReason}`
          : `${workflowName} completed ${records.length} step${records.length === 1 ? "" : "s"}.`,
        ai_result: aiResult,
        ai_metadata: aiMetadata,
        steps: records,
        logs,
        delivered,
        pdf_url: null,
        documents,
      },
    };
  };

  const capabilityChecks = assessWorkflowCapabilities(
    steps,
    mode === "test" ? "test" : "production",
  );
  const unavailable = capabilityChecks.find(({ assessment }) => !assessment.available);
  if (unavailable) {
    failureReason = unavailable.assessment.message ?? "This workflow contains an unsupported step.";
    for (const { step, assessment } of capabilityChecks) {
      const isUnavailable = step.id === unavailable.step.id;
      const status: StepExecutionStatus = isUnavailable ? "unsupported" : "skipped";
      const message = isUnavailable
        ? failureReason
        : "Not run because this workflow contains an unsupported capability.";
      records.push({
        stepId: step.id,
        capabilityId: assessment.capabilityId,
        title: step.title,
        status,
        message,
      });
      await stateHooks?.onStepFinish?.(step, {
        status: "skipped",
        message,
        error: isUnavailable ? new Error(message) : undefined,
        retryable: false,
      });
      logs.push({ icon: isUnavailable ? "⛔" : "⏭", message, stepId: step.id, status });
    }
    return finish();
  }

  const skipRemaining = async (startIndex: number, reason: string) => {
    for (const step of steps.slice(startIndex)) {
      const message = `Skipped because an earlier step failed: ${reason}`;
      records.push({
        stepId: step.id,
        capabilityId: resolveStepCapabilityId(step) ?? "unknown",
        title: step.title,
        status: "skipped",
        message,
      });
      await stateHooks?.onStepFinish?.(step, { status: "skipped", message, retryable: true });
      logs.push({ icon: "⏭", message, stepId: step.id, status: "skipped" });
    }
  };

  for (const [index, step] of steps.entries()) {
    const capabilityId = resolveStepCapabilityId(step) ?? "unknown";
    if (completedStepIds.has(step.id)) {
      const message = "Already completed in an earlier attempt; this step was not repeated.";
      records.push({ stepId: step.id, capabilityId, title: step.title, status: "succeeded", message });
      logs.push({ icon: "✅", message, stepId: step.id, status: "succeeded" });
      continue;
    }
    await stateHooks?.onStepStart?.(step);
    const succeed = async (
      message: string,
      metadata?: Record<string, string | number | boolean | null>,
      providerReferenceId?: string | null,
    ) => {
      records.push({ stepId: step.id, capabilityId, title: step.title, status: "succeeded", message });
      logs.push({ icon: "✅", message, stepId: step.id, status: "succeeded" });
      await stateHooks?.onStepFinish?.(step, { status: "succeeded", message, metadata, providerReferenceId });
    };
    const fail = async (message: string, status: "failed" | "skipped" = "failed", error?: unknown) => {
      failureReason = message;
      records.push({ stepId: step.id, capabilityId, title: step.title, status, message });
      logs.push({ icon: status === "skipped" ? "⏭" : "❌", message, stepId: step.id, status });
      await stateHooks?.onStepFinish?.(step, { status, message, error });
      await skipRemaining(index + 1, message);
    };

    if (capabilityId === "public_form_submission") {
      await succeed(
        mode === "public-form"
          ? `Received ${Object.keys(inputData).length} submitted field${Object.keys(inputData).length === 1 ? "" : "s"}.`
          : "A safe sample form submission started the test.",
      );
      continue;
    }

    if (capabilityId === "ai_text_transform") {
      if (!executeAi) {
        await fail("AI execution is not configured for this run.");
        break;
      }
      try {
        const result = await executeAi({
          instruction:
            step.config?.transformPrompt ?? step.description ?? "Transform the submission.",
          content: JSON.stringify({ input: inputData, previous_ai_result: aiResult }),
        });
        aiResult = result.text;
        aiMetadata.push({ ...result.metadata, stepId: step.id });
        variables.ai_result = aiResult;
        variables.ai_summary = aiResult;
        variables.ai = { result: aiResult, summary: aiResult };
        variables.ai_output = aiResult;
        variables.ai_content = aiResult;
        variables.ai_transformed_content = aiResult;
        variables.generated_content = aiResult;
        variables[step.id] = aiResult;
        await succeed(
          `AI completed this step using ${result.metadata.provider}/${result.metadata.model}.`,
          { provider: result.metadata.provider, model: result.metadata.model },
        );
      } catch (error: unknown) {
        securityLog("AI execution failed", { error, workflowId, stepId: step.id });
        await fail(error instanceof Error ? error.message : "The AI provider could not complete this step.", "failed", error);
        break;
      }
      continue;
    }

    if (capabilityId === "generate_pdf") {
      if (!uploadGeneratedDocument) {
        await fail("Document storage is not configured for this execution.");
        break;
      }
      try {
        const template =
          inputValues[`${step.id}-document_template`] ??
          inputValues.document_template ??
          step.config?.documentTemplate ??
          "# Document\n\n{{ai.result}}";
        const bytes = await generatePdfBuffer(populateDocumentTemplate(template, variables));
        const document = await uploadGeneratedDocument({ bytes, stepId: step.id });
        documents.push({ id: document.id, filename: document.filename });
        variables.document_id = document.id;
        await succeed("PDF generated and stored in FlowMind document storage.", { filename: document.filename }, document.id);
      } catch (error: unknown) {
        securityLog("PDF generation failed", { error });
        await fail("The PDF could not be generated or stored.", "failed", error);
        break;
      }
      continue;
    }

    if (capabilityId === "flowmind_data_store") {
      await succeed("Submission stored in FlowMind.");
      continue;
    }

    if (capabilityId === "webhook_post") {
      const destinationUrl = step.config?.endpoint?.trim();
      if (!destinationUrl) {
        await fail("Webhook delivery was skipped because no trusted destination is configured.", "skipped");
        break;
      }
      try {
        const response = await executeWebhook(destinationUrl, {
          event: "workflow_test",
          workflow_id: workflowId,
          timestamp: new Date().toISOString(),
          input_data: inputData,
          ai_result: aiResult,
          execution_idempotency_key: idempotencyKey,
          step_id: step.id,
        }, idempotencyKey ? `${idempotencyKey}:${step.id}` : undefined);
        delivered = true;
        await succeed(
          `The webhook acknowledged delivery with status ${response.status}.`,
          { httpStatus: response.status },
          response.referenceId ?? `http:${response.status}`,
        );
      } catch (error: unknown) {
        securityLog("Webhook delivery failed", { error, workflowId, stepId: step.id });
        await fail(
          "Webhook delivery failed because an acknowledgement was not received. Automatic retry is disabled to avoid duplicate delivery.",
          "failed",
          new Error("Ambiguous external result: webhook acknowledgement was not received."),
        );
        break;
      }
      continue;
    }

    await fail("This workflow step has no execution implementation.");
    break;
  }

  return finish();
}
