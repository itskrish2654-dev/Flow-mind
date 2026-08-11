"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { executeAiText } from "@/lib/ai-execution";
import { resolveStepCapabilityId } from "@/lib/capability-registry";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import { getPublicExecutableWorkflow } from "@/lib/public-workflow";
import type { Json } from "@/lib/supabase/types";
import {
  SECURITY_LIMITS,
  SecurityGateError,
  enforceRateLimit,
  enforceUsageQuota,
  withConcurrencyLease,
} from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";
import { securityLog } from "@/lib/security/redaction";
import { executeWorkflowSteps } from "@/lib/workflow-execution";

const WorkflowIdSchema = z.string().uuid();
const FieldValueSchema = z.string().trim().max(5_000);

type PublicFormOutcome =
  | "stored"
  | "pdf_generated"
  | "completed"
  | "invalid_link"
  | "rejected"
  | "invalid_submission"
  | "unavailable"
  | "execution_failed"
  | "persistence_failed"
  | "workflow_failed"
  | "rate_limited"
  | "duplicate"
  | "challenge_failed";

async function verifyTurnstile(token: string, remoteIp: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !token) return false;
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      },
    );
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function resultPath(projectId: string, outcome: PublicFormOutcome): string {
  return `/f/${encodeURIComponent(projectId)}/result?outcome=${outcome}`;
}

export async function submitPublicWorkflow(
  projectId: string,
  formData: FormData,
): Promise<never> {
  const complete = (outcome: PublicFormOutcome): never => {
    redirect(resultPath(projectId, outcome));
  };

  const parsedId = WorkflowIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    return complete("invalid_link");
  }

  const ip = await getClientIp();
  try {
    await enforceRateLimit(
      "public-form-ip",
      [ip],
      SECURITY_LIMITS.publicFormIp,
    );
    await enforceRateLimit(
      "public-form-workflow",
      [parsedId.data],
      SECURITY_LIMITS.publicFormWorkflow,
    );
  } catch {
    return complete("rate_limited");
  }

  const entries = Array.from(formData.entries());
  if (
    entries.length > 30 ||
    entries.some(([, value]) => typeof value !== "string") ||
    entries.reduce(
      (total, [key, value]) => total + key.length + String(value).length,
      0,
    ) > 50_000
  ) {
    return complete("invalid_submission");
  }

  if (String(formData.get("company_website") ?? "").trim()) {
    return complete("rejected");
  }

  const publicWorkflow = await getPublicExecutableWorkflow(parsedId.data);
  if (!publicWorkflow || publicWorkflow.capabilityError) {
    return complete("unavailable");
  }

  if (
    publicWorkflow.challengeMode === "turnstile" &&
    !(await verifyTurnstile(
      String(formData.get("cf-turnstile-response") ?? ""),
      ip,
    ))
  ) {
    return complete("challenge_failed");
  }

  const inputData: Record<string, string> = {};
  for (const field of publicWorkflow.form.fields) {
    const rawValue = formData.get(field.key);
    const value = typeof rawValue === "string" ? rawValue : "";
    const parsedValue = FieldValueSchema.safeParse(value);

    if (!parsedValue.success) {
      return complete("invalid_submission");
    }
    if (field.required && !parsedValue.data) {
      return complete("invalid_submission");
    }
    if (
      field.minLength !== undefined &&
      parsedValue.data.length < field.minLength
    ) {
      return complete("invalid_submission");
    }
    if (
      field.maxLength !== undefined &&
      parsedValue.data.length > field.maxLength
    ) {
      return complete("invalid_submission");
    }
    if (
      field.type === "email" &&
      parsedValue.data &&
      !z.string().email().safeParse(parsedValue.data).success
    ) {
      return complete("invalid_submission");
    }
    if (field.type === "url" && parsedValue.data) {
      try {
        const url = new URL(parsedValue.data);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        return complete("invalid_submission");
      }
    }
    if (
      field.type === "phone" &&
      parsedValue.data &&
      !/^[+()\d\s.-]{7,24}$/.test(parsedValue.data)
    ) {
      return complete("invalid_submission");
    }
    if (field.type === "number" && parsedValue.data) {
      const numericValue = Number(parsedValue.data);
      if (
        !Number.isFinite(numericValue) ||
        (field.min !== undefined && numericValue < field.min) ||
        (field.max !== undefined && numericValue > field.max)
      ) {
        return complete("invalid_submission");
      }
    }
    if (
      field.type === "date" &&
      parsedValue.data &&
      !isValidIsoDate(parsedValue.data)
    ) {
      return complete("invalid_submission");
    }
    if (
      field.type === "select" &&
      parsedValue.data &&
      !(field.options ?? []).includes(parsedValue.data)
    ) {
      return complete("invalid_submission");
    }

    if (field.type === "checkbox") {
      inputData[field.key] = parsedValue.data ? "Yes" : "No";
    } else if (parsedValue.data) {
      inputData[field.key] = parsedValue.data;
    }
  }

  try {
    await enforceRateLimit(
      "public-form-duplicate",
      [parsedId.data, ip, JSON.stringify(inputData)],
      SECURITY_LIMITS.publicFormDuplicate,
    );
    await enforceUsageQuota(publicWorkflow.ownerId, "public_form_submissions");
  } catch (error) {
    return complete(
      error instanceof SecurityGateError && error.code === "RATE_LIMITED"
        ? "duplicate"
        : "rate_limited",
    );
  }

  let execution: Awaited<ReturnType<typeof executeWorkflowSteps>>;
  try {
    execution = await withConcurrencyLease(
      "user-execution",
      [publicWorkflow.ownerId],
      2,
      () => withConcurrencyLease(
        "workflow-execution",
        [publicWorkflow.id],
        1,
        async () => {
          // Concurrency is acquired before execution usage is consumed.
          await enforceUsageQuota(publicWorkflow.ownerId, "executions");
          return executeWorkflowSteps({
            workflowId: publicWorkflow.id,
            workflowName: publicWorkflow.name,
            steps: publicWorkflow.workflow.steps,
            inputValues: inputData,
            mode: "public-form",
            executeAi: async (input) => {
              await enforceRateLimit(
                "ai-execution",
                [publicWorkflow.ownerId],
                SECURITY_LIMITS.ai,
              );
              await enforceUsageQuota(publicWorkflow.ownerId, "ai_generations");
              await enforceUsageQuota(
                publicWorkflow.ownerId,
                "ai_input_chars",
                input.instruction.length + input.content.length,
              );
              const result = await executeAiText(input);
              await enforceUsageQuota(
                publicWorkflow.ownerId,
                "ai_output_tokens",
                result.metadata.outputTokens ?? Math.max(1, Math.ceil(result.text.length / 4)),
              );
              return result;
            },
            uploadGeneratedDocument: async ({ bytes }) => {
              await enforceRateLimit(
                "pdf-generation",
                [publicWorkflow.ownerId],
                SECURITY_LIMITS.pdf,
              );
              await enforceUsageQuota(publicWorkflow.ownerId, "generated_documents");
              await enforceUsageQuota(publicWorkflow.ownerId, "uploads");
              await enforceUsageQuota(publicWorkflow.ownerId, "storage_bytes", bytes.byteLength);
              return uploadGeneratedDocument(
                publicWorkflow.admin,
                publicWorkflow.ownerId,
                publicWorkflow.id,
                bytes,
              );
            },
          });
        },
      ),
    );
  } catch (error: unknown) {
    securityLog("Public workflow execution failed", {
      error,
      workflowId: publicWorkflow.id,
    });
    return complete("execution_failed");
  }

  const { error } = await publicWorkflow.admin
    .from("workflow_executions")
    .insert({
      workflow_id: publicWorkflow.id,
      input_data: execution.inputData as Json,
      output_data: execution.outputData as Json,
    });

  if (error) {
    securityLog("Public execution persistence failed", {
      code: error.code,
      message: error.message,
    });
    return complete("persistence_failed");
  }
  if (!execution.ok) return complete("workflow_failed");

  const storesInternally = publicWorkflow.workflow.steps.some(
    (step) => resolveStepCapabilityId(step) === "flowmind_data_store",
  );
  const generatedDocument = execution.outputData.documents.length > 0;
  return complete(
    generatedDocument
      ? "pdf_generated"
      : storesInternally
        ? "stored"
        : "completed",
  );
}
