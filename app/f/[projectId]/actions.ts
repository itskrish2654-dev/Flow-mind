"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { executeAiText } from "@/lib/ai-execution";
import { resolveStepCapabilityId } from "@/lib/capability-registry";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import { createPublicFormTrace } from "@/lib/public-form-trace";
import { getPublicExecutableWorkflow } from "@/lib/public-workflow";
import type { Json } from "@/lib/supabase/types";
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
  | "workflow_failed";

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
  const requestId = crypto.randomUUID();
  const trace = createPublicFormTrace(requestId);
  const complete = (outcome: PublicFormOutcome): never => {
    trace("REDIRECT_START", { outcome });
    redirect(resultPath(projectId, outcome));
  };

  trace("PUBLIC_FORM_START");
  trace("VALIDATION_START");
  const parsedId = WorkflowIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    trace("VALIDATION_END", { ok: false });
    return complete("invalid_link");
  }

  if (String(formData.get("company_website") ?? "").trim()) {
    trace("VALIDATION_END", { ok: false });
    return complete("rejected");
  }
  trace("VALIDATION_END", { ok: true });

  trace("WORKFLOW_LOAD_START");
  const publicWorkflow = await getPublicExecutableWorkflow(parsedId.data, trace);
  trace("WORKFLOW_LOAD_END", { found: Boolean(publicWorkflow) });
  if (!publicWorkflow || publicWorkflow.capabilityError) {
    return complete("unavailable");
  }

  trace("FIELD_VALIDATION_START", {
    fieldCount: publicWorkflow.form.fields.length,
  });
  const inputData: Record<string, string> = {};
  for (const field of publicWorkflow.form.fields) {
    const rawValue = formData.get(field.key);
    const value = typeof rawValue === "string" ? rawValue : "";
    const parsedValue = FieldValueSchema.safeParse(value);

    if (!parsedValue.success) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (field.required && !parsedValue.data) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (
      field.minLength !== undefined &&
      parsedValue.data.length < field.minLength
    ) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (
      field.maxLength !== undefined &&
      parsedValue.data.length > field.maxLength
    ) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (
      field.type === "email" &&
      parsedValue.data &&
      !z.string().email().safeParse(parsedValue.data).success
    ) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (field.type === "url" && parsedValue.data) {
      try {
        const url = new URL(parsedValue.data);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        trace("FIELD_VALIDATION_END", { ok: false });
        return complete("invalid_submission");
      }
    }
    if (
      field.type === "phone" &&
      parsedValue.data &&
      !/^[+()\d\s.-]{7,24}$/.test(parsedValue.data)
    ) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (field.type === "number" && parsedValue.data) {
      const numericValue = Number(parsedValue.data);
      if (
        !Number.isFinite(numericValue) ||
        (field.min !== undefined && numericValue < field.min) ||
        (field.max !== undefined && numericValue > field.max)
      ) {
        trace("FIELD_VALIDATION_END", { ok: false });
        return complete("invalid_submission");
      }
    }
    if (
      field.type === "date" &&
      parsedValue.data &&
      !isValidIsoDate(parsedValue.data)
    ) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }
    if (
      field.type === "select" &&
      parsedValue.data &&
      !(field.options ?? []).includes(parsedValue.data)
    ) {
      trace("FIELD_VALIDATION_END", { ok: false });
      return complete("invalid_submission");
    }

    if (field.type === "checkbox") {
      inputData[field.key] = parsedValue.data ? "Yes" : "No";
    } else if (parsedValue.data) {
      inputData[field.key] = parsedValue.data;
    }
  }
  trace("FIELD_VALIDATION_END", { ok: true });

  let execution: Awaited<ReturnType<typeof executeWorkflowSteps>>;
  try {
    trace("EXECUTION_START");
    execution = await executeWorkflowSteps({
      workflowId: publicWorkflow.id,
      workflowName: publicWorkflow.name,
      steps: publicWorkflow.workflow.steps,
      inputValues: inputData,
      mode: "public-form",
      executeAi: async (input) => {
        trace("AI_START");
        try {
          const result = await executeAiText(input);
          trace("AI_END", { ok: true });
          return result;
        } catch (error: unknown) {
          trace("AI_END", { ok: false });
          throw error;
        }
      },
      uploadGeneratedDocument: async ({ bytes }) => {
        trace("DOCUMENT_START");
        try {
          const result = await uploadGeneratedDocument(
            publicWorkflow.admin,
            publicWorkflow.ownerId,
            publicWorkflow.id,
            bytes,
          );
          trace("DOCUMENT_END", { ok: true });
          return result;
        } catch (error: unknown) {
          trace("DOCUMENT_END", { ok: false });
          throw error;
        }
      },
    });
    trace("EXECUTION_END", { ok: execution.ok });
  } catch (error: unknown) {
    trace("EXECUTION_END", { ok: false });
    console.error("Public workflow execution failed", error);
    return complete("execution_failed");
  }

  trace("EXECUTION_PERSIST_START");
  const { error } = await publicWorkflow.admin
    .from("workflow_executions")
    .insert({
      workflow_id: publicWorkflow.id,
      input_data: execution.inputData as Json,
      output_data: execution.outputData as Json,
    });
  trace("EXECUTION_PERSIST_END", { ok: !error });

  if (error) {
    console.error("Public execution insert failed", {
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
    storesInternally
      ? "stored"
      : generatedDocument
        ? "pdf_generated"
        : "completed",
  );
}
