import type {
  AiExecutionMetadata,
  AiTextExecutor,
} from "@/lib/ai-execution-core";
import { randomUUID } from "node:crypto";
import {
  assessWorkflowCapabilities,
  getCapability,
  resolveStepCapabilityId,
} from "@/lib/capability-registry";
import { getConnectorOperation } from "@/lib/connectors/registry";
import { ConnectorError } from "@/lib/connectors/errors";
import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { applyFieldMappings, resolveMappingSource, type FieldMapping, type MappingSource } from "@/lib/connectors/mapping";
import { buildAirtableCreateRecordInput, isValidAirtableRecordId } from "@/lib/connectors/airtable/workflow-configuration";
import { executeFormatter, FormatterError, type FormatterSource } from "@/lib/formatter";
import {
  generatePdfBuffer,
  PdfRenderError,
  populateDocumentTemplate,
  type DocumentVariables,
} from "@/lib/pdf-document";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { postTrustedWebhook } from "@/lib/security/outbound-webhook";
import { securityLog } from "@/lib/security/redaction";
import { evaluateCondition } from "@/lib/workflow-conditions";
import { resolveExecutor, resolveExecutorSelection } from "@/lib/executors/router";
import {
  type CapabilityExecutor,
  DelegatedExecutionError,
} from "@/lib/executors/types";

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
  onConditionDecision?: (step: WorkflowStep, matched: boolean) => Promise<void>;
};

export type WorkflowExecutionResult = {
  ok: boolean;
  failureReason: string | null;
  logs: ExecutionLog[];
  delivered: boolean;
  providerAcknowledgements: Array<{
    stepId: string;
    capabilityId: "airtable.create_record";
    connectionId: string;
    acknowledged: true;
    providerReferenceId: string;
  }>;
  inputData: Record<string, string>;
  outputData: {
    status: "succeeded" | "failed" | "partial";
    summary: string;
    ai_result: string | null;
    ai_metadata: Array<AiExecutionMetadata & { stepId: string }>;
    formatter_results: Record<string, { operation: string; outputKey: string; value: unknown }>;
    http_results: Record<string, Record<string, unknown>>;
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
    const connectorConfig = step.config?.connector;
    if (connectorConfig) {
      const operation = getConnectorOperation(connectorConfig.connectorId, connectorConfig.operationKind, connectorConfig.operationKey, connectorConfig.operationVersion);
      if (operation?.operation.connectionRequired && !connectorConfig.connectionId) return `Choose an account for ${operation.connector.manifest.displayName}.`;
    }
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
      const endpoint = inputValues[`${step.id}-destination_url`] ?? inputValues.destination_url ?? step.config?.http?.url ?? step.config?.endpoint;
      if (!endpoint?.trim()) {
        return "Save a trusted webhook destination before running a test.";
      }
      if (step.capabilityId !== "http.request") continue;
    }

      for (const input of step.inputsRequired ?? []) {
        if (step.capabilityId === "http.request" && input.type === "secret") continue;
        const mapping = connectorConfig?.mappings.find((item) => item.target === input.key);
        const isResolvedByMapping = Boolean(
          mapping &&
          (mapping.source.kind !== "literal" ||
            (mapping.source.value !== undefined && mapping.source.value !== null && mapping.source.value !== "")),
        );
        if (isResolvedByMapping || input.required === false) continue;
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
          if (step.capabilityId === "http.request" ? parsed.protocol !== "https:" : !["http:", "https:"].includes(parsed.protocol)) {
            return step.capabilityId === "http.request" ? `${input.label} must be a public HTTPS link.` : `${input.label} must be a valid http or https link.`;
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
        !/(?:^|-)(?:destination_url|query_parameters|request_headers|json_body|request_timeout|auth_username|auth_name)$/.test(key) &&
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

function formatterValuePreview(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const compact = (serialized ?? "").replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

export async function executeWorkflowSteps({
  userId = "runtime-owner",
  workflowId,
  workflowName,
  steps,
  inputValues,
  mode,
  uploadGeneratedDocument,
  executeAi,
  executeWebhook = postTrustedWebhook,
  executeHttpRequest,
  idempotencyKey,
  telemetryExecutionId,
  workflowVersionId,
  workflowOwnerId = userId,
  allowInternalCapabilities = false,
  delegatedExecutor,
  stateHooks,
  completedStepIds = new Set<string>(),
  resumeState,
}: {
  userId?: string;
  workflowId: string;
  workflowName: string;
  steps: WorkflowStep[];
  inputValues: InputValues;
  mode: "test" | "public-form" | "scheduled";
  uploadGeneratedDocument?: GeneratedDocumentUpload;
  executeAi?: AiTextExecutor;
  executeWebhook?: TrustedWebhookExecutor;
  executeHttpRequest?: ConnectorActionHandler;
  idempotencyKey?: string;
  telemetryExecutionId?: string;
  workflowVersionId?: string;
  workflowOwnerId?: string;
  /** Test/operations-only gate. No application route enables internal capabilities. */
  allowInternalCapabilities?: boolean;
  delegatedExecutor?: CapabilityExecutor;
  stateHooks?: ExecutionStateHooks;
  completedStepIds?: Set<string>;
  resumeState?: {
    aiResult?: string | null;
    documents?: Array<{ id: string; filename: string }>;
    conditionDecisions?: Record<string, boolean>;
    stepOutputs?: Record<string, Record<string, unknown>>;
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
  const parseInputValue = (value: string): unknown => {
    const trimmed = value.trim();
    if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
    try { return JSON.parse(trimmed); } catch { return value; }
  };
  const triggerContext = Object.fromEntries(Object.entries(inputData).map(([key, value]) => [key, parseInputValue(value)]));
  const connectorStepOutputs: Record<string, Record<string, unknown>> = { ...(resumeState?.stepOutputs ?? {}) };
  const formatterResults: Record<string, { operation: string; outputKey: string; value: unknown }> = {};
  const httpResults: Record<string, Record<string, unknown>> = {};
  const providerAcknowledgements: WorkflowExecutionResult["providerAcknowledgements"] = [];
  let delivered = false;
  let aiResult: string | null = resumeState?.aiResult ?? null;
  let failureReason: string | null = null;
  const conditionDecisions: Record<string, boolean> = { ...(resumeState?.conditionDecisions ?? {}) };
  for (const [stepId, output] of Object.entries(connectorStepOutputs)) {
    variables[stepId] = output;
    for (const [key, value] of Object.entries(output)) {
      if (key !== "value") variables[key] = value;
    }
    const formatterStep = steps.find((step) => step.id === stepId && step.type === "formatter_transform");
    if (formatterStep?.config?.formatter) {
      formatterResults[stepId] = {
        operation: formatterStep.config.formatter.operation,
        outputKey: formatterStep.config.formatter.outputKey,
        value: output.value,
      };
    }
    if (steps.some((step) => step.id === stepId && step.capabilityId === "http.request")) httpResults[stepId] = output;
  }
  if (aiResult) {
    variables.ai_result = aiResult;
    variables.ai_summary = aiResult;
    variables.ai = { result: aiResult, summary: aiResult };
    for (const step of steps) {
      if (step.type === "ai_transform" && completedStepIds.has(step.id)) {
        connectorStepOutputs[step.id] = { result: aiResult };
      }
    }
  }

  const finish = (): WorkflowExecutionResult => {
    const succeeded = records.filter((record) => record.status === "succeeded").length;
    const failed = failureReason !== null || records.some((record) =>
      ["failed", "unsupported"].includes(record.status),
    );
    const status = failed ? (succeeded > 0 ? "partial" : "failed") : "succeeded";
    return {
      ok: !failed,
      failureReason,
      logs,
      delivered,
      providerAcknowledgements,
      inputData,
      outputData: {
        status,
        summary: failureReason
          ? `${workflowName} stopped: ${failureReason}`
          : `${workflowName} completed ${records.length} step${records.length === 1 ? "" : "s"}.`,
        ai_result: aiResult,
        ai_metadata: aiMetadata,
        formatter_results: formatterResults,
        http_results: httpResults,
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
  const unavailable = capabilityChecks.find(({ step, assessment }) => {
    if (!assessment.available) return true;
    const capability = getCapability(resolveStepCapabilityId(step) ?? "");
    return Boolean(capability?.internalOnly && !allowInternalCapabilities);
  });
  if (unavailable) {
    const unavailableCapability = getCapability(unavailable.assessment.capabilityId);
    failureReason = unavailableCapability?.internalOnly
      ? "This workflow contains an unsupported step."
      : unavailable.assessment.message ?? "This workflow contains an unsupported step.";
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
    const branch = step.config?.branch;
    if (branch) {
      const decision = conditionDecisions[branch.conditionStepId];
      if (decision === undefined) {
        const message = "This branch could not run because its condition decision is unavailable.";
        failureReason = message;
        records.push({ stepId: step.id, capabilityId, title: step.title, status: "failed", message });
        logs.push({ icon: "❌", message, stepId: step.id, status: "failed" });
        await stateHooks?.onStepFinish?.(step, { status: "failed", message, error: new Error(message), retryable: false });
        await skipRemaining(index + 1, message);
        break;
      }
      if (decision !== (branch.when === "true")) {
        const message = "Skipped — condition not matched.";
        records.push({ stepId: step.id, capabilityId, title: step.title, status: "skipped", message });
        logs.push({ icon: "⏭", message, stepId: step.id, status: "skipped" });
        await stateHooks?.onStepFinish?.(step, { status: "skipped", message, retryable: false, metadata: { branchMatched: false } });
        continue;
      }
    }
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
    const fail = async (
      message: string,
      status: "failed" | "skipped" = "failed",
      error?: unknown,
      retryable?: boolean,
      metadata?: Record<string, string | number | boolean | null>,
    ) => {
      failureReason = message;
      records.push({ stepId: step.id, capabilityId, title: step.title, status, message });
      logs.push({ icon: status === "skipped" ? "⏭" : "❌", message, stepId: step.id, status });
      await stateHooks?.onStepFinish?.(step, { status, message, error, retryable, metadata });
      await skipRemaining(index + 1, message);
    };

    let executorSelection;
    try {
      executorSelection = resolveExecutorSelection(step, capabilityId);
    } catch (error) {
      const normalized = error instanceof DelegatedExecutionError
        ? error
        : new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
      await fail(normalized.message, "failed", normalized, normalized.retryable);
      break;
    }

    if (executorSelection.kind !== "native") {
      const capability = getCapability(capabilityId);
      const internalAuthorized = Boolean(capability?.internalOnly && allowInternalCapabilities);
      const customerDelegatedAuthorized = Boolean(
        capability &&
        executorSelection.kind === "connector_runner" &&
        !capability.internalOnly &&
        (mode === "test" ? capability.availableInTest : capability.availableInProduction),
      );
      if (!internalAuthorized && !customerDelegatedAuthorized) {
        const error = new DelegatedExecutionError("DELEGATED_AUTH_FAILED", false);
        await fail(error.message, "failed", error, false);
        break;
      }
      if (!telemetryExecutionId || !workflowVersionId) {
        const error = new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
        await fail(error.message, "failed", error, false);
        break;
      }
      const executor = delegatedExecutor ?? resolveExecutor(executorSelection);
      if (!executor || executor.kind !== executorSelection.kind) {
        const error = new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
        await fail(error.message, "failed", error, false);
        break;
      }
      const logicalIdempotencyKey = `${idempotencyKey ?? telemetryExecutionId}:${step.id}:v${executorSelection.capabilityVersion}`;
      let delegatedInput: Record<string, unknown>;
      try {
        delegatedInput = capabilityId === "internal.bridge_echo"
          ? { message: inputValues.message ?? "" }
          : capabilityId === "internal.connector_runner_canary"
            ? { simulation: inputValues.simulation ?? "success" }
            : capabilityId === "airtable.create_record"
              ? buildAirtableCreateRecordInput({
                  baseId: inputValues[`${step.id}-baseId`] ?? "",
                  tableId: inputValues[`${step.id}-tableId`] ?? "",
                  fieldMappings: inputValues[`${step.id}-fields`] ?? "",
                  workflowValues: { ...triggerContext, ...variables, steps: connectorStepOutputs },
                })
              : {};
      } catch (error) {
        await fail(error instanceof Error ? error.message : "This connector setup is invalid.", "failed", error, false);
        break;
      }
      const connectionId = step.config?.connector?.connectionId;
      if (capabilityId === "airtable.create_record" && !connectionId) {
        const error = new DelegatedExecutionError("DELEGATED_AUTH_FAILED", false);
        await fail(
          mode === "test"
            ? "Choose an Airtable connection before running this TEST."
            : "Choose a verified Airtable connection before running this loop.",
          "failed",
          error,
          false,
        );
        break;
      }
      const delegatedMode = mode === "test" ? "TEST" : "LIVE";
      const result = await executor.execute({
        authenticatedUserId: userId,
        workflowOwnerId,
        ...(connectionId && step.config?.connector ? {
          credentialReference: {
            connectionId,
            connectorId: step.config.connector.connectorId,
          },
        } : {}),
        envelope: {
          protocolVersion: 1,
          requestId: randomUUID(),
          executionId: telemetryExecutionId,
          workflowVersionId,
          stepId: step.id,
          capabilityId,
          capabilityVersion: executorSelection.capabilityVersion,
          mode: delegatedMode,
          idempotencyKey: logicalIdempotencyKey,
          input: delegatedInput,
        },
      });
      if (!result.ok) {
        const retryable = capabilityId === "airtable.create_record" ? false : result.retryable;
        const error = new DelegatedExecutionError(result.errorCategory, retryable);
        await fail(error.message, "failed", error, retryable);
        break;
      }
      connectorStepOutputs[step.id] = result.output;
      variables[step.id] = result.output;
      for (const [key, value] of Object.entries(result.output)) variables[key] = value;
      if (capabilityId === "airtable.create_record") {
        const recordId = result.output.recordId;
        if (!isValidAirtableRecordId(recordId)) {
          const error = new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
          await fail(error.message, "failed", error, false);
          break;
        }
        delivered = true;
        await succeed(
          "Create Airtable record was acknowledged by Airtable.",
          { provider: "airtable", operation: "create_record", acknowledged: true, mode: delegatedMode },
          recordId,
        );
        providerAcknowledgements.push({
          stepId: step.id,
          capabilityId: "airtable.create_record",
          connectionId: connectionId!,
          acknowledged: true,
          providerReferenceId: recordId,
        });
      } else {
        await succeed("This step completed.");
      }
      continue;
    }

    if (capabilityId === "public_form_submission" || capabilityId === "generic_webhook_trigger" || capabilityId === "manual_trigger" || capabilityId === "schedule.trigger" || step.type === "connector_trigger") {
      await succeed(
        capabilityId === "generic_webhook_trigger"
          ? "Received an authenticated webhook event."
          : capabilityId.startsWith("gmail_")
            ? "Received and resolved a new Gmail message."
          : capabilityId === "schedule.trigger"
            ? mode === "test"
              ? "Simulated the configured scheduled occurrence for this live test."
              : "Started from the configured durable schedule."
          : capabilityId === "manual_trigger"
            ? "Started by an authenticated manual run."
          : mode === "public-form"
          ? `Received ${Object.keys(inputData).length} submitted field${Object.keys(inputData).length === 1 ? "" : "s"}.`
          : "A safe sample form submission started the test.",
      );
      continue;
    }

    if (capabilityId === "condition.if") {
      const condition = step.config?.condition;
      if (!condition) {
        await fail("This condition is missing its structured rule.");
        break;
      }
      const conditionContext: Record<string, unknown> = {
        ...triggerContext,
        ...variables,
        steps: connectorStepOutputs,
      };
      const decision = evaluateCondition(condition, conditionContext);
      conditionDecisions[step.id] = decision.matched;
      await stateHooks?.onConditionDecision?.(step, decision.matched);
      await succeed(
        `${condition.humanLabel}: ${decision.matched ? "matched" : "did not match"}.`,
        { conditionMatched: decision.matched },
      );
      continue;
    }

    if (capabilityId === "formatter.transform") {
      const formatter = step.config?.formatter;
      if (!formatter) {
        await fail("This formatter step is missing its structured configuration.", "failed", new FormatterError("FORMATTER_INVALID_INPUT", "This formatter step is missing its structured configuration."));
        break;
      }
      const mappingContext = { trigger: triggerContext, steps: connectorStepOutputs };
      const toMappingSource = (source: FormatterSource): MappingSource => {
        if (source.kind === "literal") return { kind: "literal", value: source.value };
        if (source.kind === "trigger") return { kind: "trigger", path: source.path ?? "" };
        if (!source.stepId) throw new FormatterError("FORMATTER_INVALID_INPUT", "A prior step reference is required.");
        if (source.kind === "ai") return { kind: "ai", stepId: source.stepId, path: source.path };
        return { kind: "step", stepId: source.stepId, path: source.path ?? "" };
      };
      try {
        const input = resolveMappingSource(toMappingSource(formatter.source), mappingContext);
        const fallbackInputs = (formatter.sources ?? []).map((source) => resolveMappingSource(toMappingSource(source), mappingContext));
        const value = executeFormatter(formatter, input, fallbackInputs);
        const output = { value, [formatter.outputKey]: value };
        connectorStepOutputs[step.id] = output;
        variables[step.id] = output;
        variables[formatter.outputKey] = value;
        formatterResults[step.id] = { operation: formatter.operation, outputKey: formatter.outputKey, value };
        await succeed(
          mode === "test"
            ? `${step.title} completed. Output: ${formatterValuePreview(value) || "(empty)"}`
            : `${step.title} completed deterministically.`,
          {
            formatterOperation: formatter.operation,
            formatterOutput: JSON.stringify({ outputKey: formatter.outputKey, value }),
          },
        );
      } catch (error) {
        await fail(error instanceof FormatterError ? error.message : "The formatter could not complete this operation.", "failed", error);
        break;
      }
      continue;
    }

    if (step.type === "connector_action") {
      const connectorConfig = step.config?.connector;
      if (!connectorConfig || connectorConfig.operationKind !== "action") { await fail("This connector action is missing its versioned operation configuration."); break; }
      const registered = getConnectorOperation(connectorConfig.connectorId, "action", connectorConfig.operationKey, connectorConfig.operationVersion);
      if (!registered || typeof registered.handler !== "function") { await fail("This connector action is not supported by the current server runtime."); break; }
      if (mode !== "test" && !registered.operation.production) { await fail("This connector action is not available in production."); break; }
      const direct: Record<string, unknown> = {};
      for (const field of registered.operation.input) {
        const configured = inputValues[`${step.id}-${field.key}`] ?? inputValues[field.key] ?? step.config?.connector?.settings?.[field.key];
        if (configured !== undefined && configured !== "") {
          if (field.type === "number") direct[field.key] = Number(configured);
          else if (field.type === "boolean") direct[field.key] = configured === "true";
          else if (field.type === "object" && typeof configured === "string") { try { direct[field.key] = JSON.parse(configured); } catch { direct[field.key] = configured; } }
          else direct[field.key] = configured;
        }
      }
      try {
        const unresolvedFields = registered.operation.input.filter((field) => direct[field.key] === undefined);
        const mapped = applyFieldMappings(unresolvedFields, connectorConfig.mappings as FieldMapping[], { trigger: triggerContext, steps: connectorStepOutputs });
        const connectorInput: Record<string, unknown> = { ...mapped, ...direct };
        if (registered.operation.input.some((field) => field.key === "values") && connectorInput.values === undefined) connectorInput.values = triggerContext.message ?? triggerContext;
        if (connectorConfig.connectorId === "google_sheets" && connectorInput.values && typeof connectorInput.values === "object" && !Array.isArray(connectorInput.values)) {
          const latestAi = Object.values(connectorStepOutputs).reverse().find((output) => typeof output.result === "string");
          connectorInput.values = {
            ...triggerContext,
            ...(connectorInput.values as Record<string, unknown>),
            ...(latestAi ? { summary: latestAi.result, ai_result: latestAi.result } : {}),
          };
        }
        if (connectorConfig.connectorId === "notion" && connectorInput.values && typeof connectorInput.values === "object" && !Array.isArray(connectorInput.values)) {
          const latestAi = Object.values(connectorStepOutputs).reverse().find((output) => typeof output.result === "string");
          connectorInput.values = {
            ...(connectorInput.values as Record<string, unknown>),
            ...(latestAi ? { Summary: latestAi.result, ai_result: latestAi.result } : {}),
          };
        }
        const result = await registered.handler(connectorInput, { userId, workflowId, executionId: telemetryExecutionId ?? idempotencyKey ?? workflowId, stepId: step.id, ...(connectorConfig.connectionId ? { connectionId: connectorConfig.connectionId } : {}), idempotencyKey: `${idempotencyKey ?? workflowId}:${step.id}` });
        if (result.status !== "succeeded" || !result.acknowledged) { await fail(result.error?.message ?? "The connector did not acknowledge this action.", "failed", result.error ? new ConnectorError(result.error) : undefined); break; }
        connectorStepOutputs[step.id] = result.output; variables[step.id] = result.output;
        delivered = delivered || result.externallyDelivered;
        await succeed(result.externallyDelivered ? `${registered.operation.displayName} was acknowledged by the provider.` : `${registered.operation.displayName} completed.`, result.metadata, result.providerReferenceId);
      } catch (error) { await fail(error instanceof Error ? error.message : "The connector action failed.", "failed", error); break; }
      continue;
    }

    if (capabilityId === "http.request") {
      const http = step.config?.http;
      const connectorConfig = step.config?.connector;
      if (!http || !connectorConfig || connectorConfig.operationKey !== "request" || connectorConfig.operationVersion !== 2) {
        await fail("This HTTP request is missing its versioned operation configuration.");
        break;
      }
      const registered = getConnectorOperation("flowmind_http", "action", "request", 2);
      if (!registered || typeof registered.handler !== "function") {
        await fail("This HTTP request is not supported by the current server runtime.");
        break;
      }
      const value = (key: string) => inputValues[`${step.id}-${key}`] ?? inputValues[key];
      const flattenedFormatterValues = Object.values(formatterResults).reduce<Record<string, unknown>>((result, item) => {
        result[item.outputKey] = item.value;
        return result;
      }, {});
      const configuredBody = value("json_body");
      const defaultBody = { ...triggerContext, ...flattenedFormatterValues, ...(aiResult ? { ai_result: aiResult } : {}) };
      const connectorInput: Record<string, unknown> = {
        url: value("destination_url") ?? http.url,
        method: http.method,
        query: value("query_parameters") || http.query,
        headers: value("request_headers") || http.headers,
        body: configuredBody || http.body || (["POST", "PUT", "PATCH"].includes(http.method) || (http.method === "DELETE" && http.allowDeleteBody) ? defaultBody : undefined),
        timeoutMs: value("request_timeout") || http.timeoutMs,
        authType: http.authType,
        authUsername: value("auth_username") ?? http.authUsername,
        authName: value("auth_name") ?? http.authName,
        idempotencyHeader: http.idempotencyHeader,
        allowDeleteBody: http.allowDeleteBody,
      };
      try {
        const handler = executeHttpRequest ?? registered.handler;
        const result = await handler(connectorInput, {
          userId,
          workflowId,
          executionId: telemetryExecutionId ?? idempotencyKey ?? workflowId,
          stepId: step.id,
          idempotencyKey: `${idempotencyKey ?? workflowId}:${step.id}`,
        });
        if (result.status !== "succeeded" || !result.acknowledged) {
          const connectorError = result.error ? new ConnectorError(result.error) : new Error("The API did not acknowledge this request.");
          const failedOutput = { method: http.method, ...result.output, acknowledged: false, completed: false, ...(result.error ? { errorCode: result.error.code, retryable: result.error.retryable } : {}) };
          connectorStepOutputs[step.id] = failedOutput;
          httpResults[step.id] = failedOutput;
          await fail(
            `${result.error?.message ?? "The API did not acknowledge this request."}${result.error?.retryable ? " Retry available." : ""}`,
            "failed",
            connectorError,
            result.error?.retryable ?? false,
            result.metadata,
          );
          break;
        }
        connectorStepOutputs[step.id] = result.output;
        httpResults[step.id] = result.output;
        variables[step.id] = result.output;
        for (const [key, outputValue] of Object.entries(result.output)) variables[key] = outputValue;
        delivered = delivered || result.externallyDelivered;
        const status = typeof result.output.status === "number" ? result.output.status : null;
        await succeed(
          http.method === "GET"
            ? `${step.title} completed${status ? ` with ${status}` : ""}.`
            : `${step.title} was acknowledged${status ? ` with ${status}` : ""}.`,
          result.metadata,
          result.providerReferenceId,
        );
      } catch (error) {
        const details = error instanceof ConnectorError ? error.details : null;
        await fail(error instanceof Error ? error.message : "The HTTP request failed.", "failed", error, details?.retryable ?? false, details?.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : undefined);
        break;
      }
      continue;
    }

    if (capabilityId === "generic_http_action") {
      const connectorConfig = step.config?.connector;
      if (!connectorConfig || connectorConfig.operationKind !== "action") {
        await fail("This connector action is missing its versioned operation configuration.");
        break;
      }
      const registered = getConnectorOperation(
        connectorConfig.connectorId,
        "action",
        connectorConfig.operationKey,
        connectorConfig.operationVersion,
      );
      if (!registered || typeof registered.handler !== "function") {
        await fail("This connector action is not supported by the current server runtime.");
        break;
      }
      if (mode !== "test" && !registered.operation.production) {
        await fail("This connector action is not available in production.");
        break;
      }
      const destinationUrl = step.config?.endpoint?.trim();
      if (!destinationUrl) {
        await fail("HTTP delivery was skipped because no trusted destination is configured.", "skipped");
        break;
      }
      const connectorInput = {
        url: destinationUrl,
        body: {
          event: "workflow_execution",
          workflow_id: workflowId,
          input_data: inputData,
          ai_result: aiResult,
        },
      };
      const result = await registered.handler(connectorInput, {
        userId,
        workflowId,
        executionId: telemetryExecutionId ?? idempotencyKey ?? workflowId,
        stepId: step.id,
        ...(connectorConfig.connectionId ? { connectionId: connectorConfig.connectionId } : {}),
        idempotencyKey: `${idempotencyKey ?? workflowId}:${step.id}`,
      });
      if (result.status !== "succeeded" || !result.acknowledged) {
        await fail(result.error?.message ?? "The connector did not acknowledge this action.", "failed", result.error);
        break;
      }
      delivered = result.externallyDelivered;
      await succeed(
        result.externallyDelivered
          ? "The HTTP destination acknowledged delivery."
          : "The connector action completed without external delivery.",
        result.metadata,
        result.providerReferenceId,
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
        connectorStepOutputs[step.id] = { result: aiResult };
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
        await succeed("PDF generated and stored in CrazyLoops document storage.", { filename: document.filename }, document.id);
      } catch (error: unknown) {
        securityLog("PDF generation failed", { error });
        await fail(error instanceof PdfRenderError ? error.message : "The PDF could not be generated or stored.", "failed", error);
        break;
      }
      continue;
    }

    if (capabilityId === "flowmind_data_store") {
      await succeed("Submission stored in CrazyLoops.");
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
        const message = error instanceof Error ? error.message : "Webhook delivery failed.";
        const definitivelyRetryable = /^Webhook returned status (429|5\d\d)\.$/.test(message);
        await fail(
          definitivelyRetryable
            ? `${message} The provider acknowledged a temporary failure, so this step can be retried safely.`
            : "Webhook delivery failed because an acknowledgement was not received. Automatic retry is disabled to avoid duplicate delivery.",
          "failed",
          definitivelyRetryable
            ? error
            : new Error("Ambiguous external result: webhook acknowledgement was not received."),
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
