"use server";

import { z } from "zod";

import { executeAiText } from "@/lib/ai-execution";
import { resolveStepCapabilityId } from "@/lib/capability-registry";
import type { PublicFormSubmissionState } from "@/lib/public-form";
import { createPublicFormTrace } from "@/lib/public-form-trace";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import { getPublicExecutableWorkflow } from "@/lib/public-workflow";
import type { Json } from "@/lib/supabase/types";
import { executeWorkflowSteps } from "@/lib/workflow-execution";

const WorkflowIdSchema = z.string().uuid();
const FieldValueSchema = z.string().trim().max(5_000);

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

export async function submitPublicWorkflow(
  projectId: string,
  _previousState: PublicFormSubmissionState,
  formData: FormData,
): Promise<PublicFormSubmissionState> {
  const requestId = crypto.randomUUID();
  const trace = createPublicFormTrace(requestId);
  const finish = (state: PublicFormSubmissionState) => {
    trace("ACTION_RETURN_START", { status: state.status });
    trace("ACTION_RETURN_VALUE_READY", { status: state.status });
    return state;
  };

  trace("PUBLIC_FORM_START");
  trace("VALIDATION_START");
  const parsedId = WorkflowIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    trace("VALIDATION_END", { ok: false });
    return finish({ status: "error", message: "This form link is invalid." });
  }

  if (String(formData.get("company_website") ?? "").trim()) {
    trace("VALIDATION_END", { ok: false });
    return finish({
      status: "error",
      message: "This submission was rejected.",
    });
  }
  trace("VALIDATION_END", { ok: true });

  trace("WORKFLOW_LOAD_START");
  const publicWorkflow = await getPublicExecutableWorkflow(parsedId.data, trace);
  trace("WORKFLOW_LOAD_END", { found: Boolean(publicWorkflow) });
  if (!publicWorkflow) {
    return finish({
      status: "error",
      message: "This form is no longer accepting submissions.",
    });
  }
  if (publicWorkflow.capabilityError) {
    return finish({
      status: "error",
      message: publicWorkflow.capabilityError,
    });
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
      return {
        status: "error",
        message: `${field.label} must be 5,000 characters or fewer.`,
      };
    }
    if (field.required && !parsedValue.data) {
      return { status: "error", message: `${field.label} is required.` };
    }
    if (
      field.minLength !== undefined &&
      parsedValue.data.length < field.minLength
    ) {
      return {
        status: "error",
        message: `${field.label} must contain at least ${field.minLength} characters.`,
      };
    }
    if (
      field.maxLength !== undefined &&
      parsedValue.data.length > field.maxLength
    ) {
      return {
        status: "error",
        message: `${field.label} must contain ${field.maxLength} characters or fewer.`,
      };
    }
    if (
      field.type === "email" &&
      parsedValue.data &&
      !z.string().email().safeParse(parsedValue.data).success
    ) {
      return { status: "error", message: "Enter a valid email address." };
    }
    if (field.type === "url" && parsedValue.data) {
      try {
        const url = new URL(parsedValue.data);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        return { status: "error", message: `${field.label} must be a valid link.` };
      }
    }

    if (
      field.type === "phone" &&
      parsedValue.data &&
      !/^[+()\d\s.-]{7,24}$/.test(parsedValue.data)
    ) {
      return { status: "error", message: `${field.label} must be a valid phone number.` };
    }

    if (field.type === "number" && parsedValue.data) {
      const numericValue = Number(parsedValue.data);
      if (!Number.isFinite(numericValue)) {
        return { status: "error", message: `${field.label} must be a valid number.` };
      }
      if (field.min !== undefined && numericValue < field.min) {
        return { status: "error", message: `${field.label} must be at least ${field.min}.` };
      }
      if (field.max !== undefined && numericValue > field.max) {
        return { status: "error", message: `${field.label} must be ${field.max} or less.` };
      }
    }

    if (
      field.type === "date" &&
      parsedValue.data &&
      !isValidIsoDate(parsedValue.data)
    ) {
      return { status: "error", message: `${field.label} must be a valid date.` };
    }

    if (
      field.type === "select" &&
      parsedValue.data &&
      !(field.options ?? []).includes(parsedValue.data)
    ) {
      return { status: "error", message: `Choose a valid option for ${field.label}.` };
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
    return finish({
      status: "error",
      message: "We couldn't complete this workflow safely. Please try again.",
    });
  }

  trace("EXECUTION_PERSIST_START");
  const { error } = await publicWorkflow.admin.from("workflow_executions").insert({
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
    return finish({
      status: "error",
      message: "We couldn’t process this submission. Please try again.",
    });
  }

  if (!execution.ok) {
    return finish({
      status: "error",
      message:
        execution.failureReason ?? "This workflow could not complete the submission.",
    });
  }

  const storesInternally = publicWorkflow.workflow.steps.some(
    (step) => resolveStepCapabilityId(step) === "flowmind_data_store",
  );
  const generatedDocument = execution.outputData.documents.length > 0;

  trace("REVALIDATION_SKIPPED");
  trace("REDIRECT_SKIPPED");
  return finish({
    status: "success",
    message: storesInternally
      ? "Thank you! Your submission has been stored in FlowMind."
      : generatedDocument
        ? "Thank you! Your PDF has been generated and stored in FlowMind."
        : "Thank you! The workflow completed successfully.",
  });
}
