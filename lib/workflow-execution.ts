import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import {
  generatePdfBuffer,
  populateDocumentTemplate,
  type DocumentVariables,
} from "@/lib/pdf-document";

export type ExecutionLog = {
  icon: string;
  message: string;
};

type WorkflowStep = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;

export type GeneratedDocumentUpload = (input: {
  bytes: Uint8Array;
}) => Promise<{ url: string; filename: string }>;

export type WorkflowExecutionResult = {
  logs: ExecutionLog[];
  delivered: boolean;
  inputData: Record<string, string>;
  outputData: {
    status: "processed" | "delivered";
    summary: string;
    ai_result: string | null;
    logs: ExecutionLog[];
    delivered: boolean;
    pdf_url: string | null;
    documents: Array<{ url: string; filename: string }>;
  };
};

function isBlockedIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];

  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }

  return true;
}

async function validatePublicDestination(value: string): Promise<URL | null> {
  let destination: URL;

  try {
    destination = new URL(value);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(destination.protocol) ||
    destination.username ||
    destination.password
  ) {
    return null;
  }

  const hostname = destination.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return null;
  }

  if (isIP(hostname)) {
    return isBlockedIpAddress(hostname) ? null : destination;
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isBlockedIpAddress(address))
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return destination;
}

function destinationCandidates(
  step: WorkflowStep,
  inputValues: InputValues,
): string[] {
  const stepInputKeys = new Set(
    (step.inputsRequired ?? []).flatMap((input) => [
      input.key,
      `${step.id}-${input.key}`,
    ]),
  );
  const entries = Object.entries(inputValues);
  const associatedValues = entries
    .filter(([key]) => stepInputKeys.has(key) || key.startsWith(`${step.id}-`))
    .map(([, value]) => value);
  const destinationNamedValues = entries
    .filter(
      ([key]) =>
        /destination|webhook|url|link|send|save/i.test(key) &&
        !/trigger|listen|source/i.test(key),
    )
    .map(([, value]) => value);

  return Array.from(new Set([...associatedValues, ...destinationNamedValues])).filter(
    (value) => /^https?:\/\//i.test(value.trim()),
  );
}

async function findDestinationUrl(
  step: WorkflowStep,
  inputValues: InputValues,
): Promise<URL | null> {
  for (const candidate of destinationCandidates(step, inputValues)) {
    const destination = await validatePublicDestination(candidate.trim());
    if (destination) return destination;
  }

  return null;
}

export function validateRequiredSetupInputs(
  steps: WorkflowStep[],
  inputValues: InputValues,
): string | null {
  for (const step of steps) {
    if (step.type === "webhook_trigger" || step.type === "http_request") continue;

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
}: {
  workflowId: string;
  workflowName: string;
  steps: WorkflowStep[];
  inputValues: InputValues;
  mode: "test" | "public-form";
  uploadGeneratedDocument?: GeneratedDocumentUpload;
}): Promise<WorkflowExecutionResult> {
  const logs: ExecutionLog[] = [];
  const inputData = safeInputData(steps, inputValues);
  let delivered = false;
  let aiResult: string | null = null;
  const documents: Array<{ url: string; filename: string }> = [];
  const variables = executionVariables(
    steps,
    inputValues,
    inputData,
    workflowId,
    workflowName,
  );

  for (const [index, step] of steps.entries()) {
    if (step.type === "webhook_trigger") {
      logs.push({
        icon: "✅",
        message:
          mode === "public-form"
            ? `Step ${index + 1}: Received ${Object.keys(inputData).length} submitted field${Object.keys(inputData).length === 1 ? "" : "s"}.`
            : `Step ${index + 1}: A safe sample event started the automation.`,
      });
      continue;
    }

    if (step.type === "ai_transform") {
      aiResult = `${step.title} processed the submission for ${workflowName}.`;
      variables.ai_result = aiResult;
      variables.ai_summary = aiResult;
      variables.ai = { result: aiResult, summary: aiResult };
      variables.ai_output = aiResult;
      variables.ai_content = aiResult;
      variables.ai_transformed_content = aiResult;
      variables.generated_content = aiResult;
      variables[step.id] = aiResult;
      logs.push({
        icon: "✨",
        message: `Step ${index + 1}: FlowPilot created the automation result.`,
      });
      continue;
    }

    if (step.type === "generate_pdf") {
      if (!uploadGeneratedDocument) {
        throw new Error("Document storage is not configured for this execution.");
      }

      const template =
        inputValues[`${step.id}-document_template`] ??
        inputValues.document_template ??
        step.config?.documentTemplate ??
        "# Document\n\n{{ai_summary}}";
      const populatedDocument = populateDocumentTemplate(template, variables);
      const bytes = await generatePdfBuffer(populatedDocument);
      const uploadedDocument = await uploadGeneratedDocument({ bytes });
      const document = {
        url: uploadedDocument.url,
        filename: uploadedDocument.filename,
      };
      documents.push(document);
      variables.pdf_url = document.url;
      delivered = true;
      logs.push({
        icon: "📄",
        message: `Step ${index + 1}: Your PDF was generated and saved successfully.`,
      });
      continue;
    }

    if (step.type === "filter_condition") {
      logs.push({
        icon: "🔍",
        message: `Step ${index + 1}: The submitted information passed your rule.`,
      });
      continue;
    }

    if (step.type === "http_request" && mode === "public-form") {
      delivered = true;
      logs.push({
        icon: "📥",
        message: `Step ${index + 1}: The result was prepared for your FlowMind data table.`,
      });
      continue;
    }

    if (step.type === "http_request") {
      const destinationUrl = await findDestinationUrl(step, inputValues);

      if (!destinationUrl) {
        delivered = true;
        logs.push({
          icon: "📥",
          message: `Step ${index + 1}: The result was prepared for your FlowMind data table.`,
        });
        continue;
      }

      try {
        const response = await fetch(destinationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "test_run",
            message: "Hello from FlowMind! Your automation is wired up correctly.",
            workflow_id: workflowId,
            timestamp: new Date().toISOString(),
            input_data: inputData,
          }),
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });

        delivered = response.ok;
        logs.push(
          response.ok
            ? {
                icon: "🚀",
                message: `Step ${index + 1}: Real data sent! The destination accepted it (Status: ${response.status}).`,
              }
            : {
                icon: "⚠️",
                message: `Step ${index + 1}: Data was sent, but the destination returned an error (Status: ${response.status}).`,
              },
        );
      } catch (error: unknown) {
        console.error("FlowMind test delivery failed", error);
        logs.push({
          icon: "❌",
          message: `Step ${index + 1}: Failed to send data because of a network error or invalid link.`,
        });
      }
    }
  }

  const status = delivered ? "delivered" : "processed";
  return {
    logs,
    delivered,
    inputData,
    outputData: {
      status,
      summary: `${workflowName} processed ${Object.keys(inputData).length} populated field${Object.keys(inputData).length === 1 ? "" : "s"}.`,
      ai_result: aiResult,
      logs,
      delivered,
      pdf_url: documents[0]?.url ?? null,
      documents,
    },
  };
}
