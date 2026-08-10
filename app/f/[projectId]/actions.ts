"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { executeAiText } from "@/lib/ai-execution";
import { resolveStepCapabilityId } from "@/lib/capability-registry";
import { uploadGeneratedDocument } from "@/lib/document-storage";
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
  const complete = (outcome: PublicFormOutcome): never => {
    redirect(resultPath(projectId, outcome));
  };

  const parsedId = WorkflowIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    return complete("invalid_link");
  }

  if (String(formData.get("company_website") ?? "").trim()) {
    return complete("rejected");
  }

  const publicWorkflow = await getPublicExecutableWorkflow(parsedId.data);
  if (!publicWorkflow || publicWorkflow.capabilityError) {
    return complete("unavailable");
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

  let execution: Awaited<ReturnType<typeof executeWorkflowSteps>>;
  try {
    execution = await executeWorkflowSteps({
      workflowId: publicWorkflow.id,
      workflowName: publicWorkflow.name,
      steps: publicWorkflow.workflow.steps,
      inputValues: inputData,
      mode: "public-form",
      executeAi: executeAiText,
      uploadGeneratedDocument: async ({ bytes }) =>
        uploadGeneratedDocument(
          publicWorkflow.admin,
          publicWorkflow.ownerId,
          publicWorkflow.id,
          bytes,
        ),
    });
  } catch (error: unknown) {
    console.error("Public workflow execution failed", error);
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
    generatedDocument
      ? "pdf_generated"
      : storesInternally
        ? "stored"
        : "completed",
  );
}
