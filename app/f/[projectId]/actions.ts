"use server";

import { z } from "zod";

import type { PublicFormSubmissionState } from "@/lib/public-form";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import { getPublicExecutableWorkflow } from "@/lib/public-workflow";
import type { Json } from "@/lib/supabase/types";
import { executeWorkflowSteps } from "@/lib/workflow-execution";

const WorkflowIdSchema = z.string().uuid();
const FieldValueSchema = z.string().trim().max(5_000);

export async function submitPublicWorkflow(
  projectId: string,
  _previousState: PublicFormSubmissionState,
  formData: FormData,
): Promise<PublicFormSubmissionState> {
  const parsedId = WorkflowIdSchema.safeParse(projectId);
  if (!parsedId.success) {
    return { status: "error", message: "This form link is invalid." };
  }

  if (String(formData.get("company_website") ?? "").trim()) {
    return {
      status: "success",
      message: "Thank you! Your submission has been processed.",
    };
  }

  const publicWorkflow = await getPublicExecutableWorkflow(parsedId.data);
  if (!publicWorkflow) {
    return {
      status: "error",
      message: "This form is no longer accepting submissions.",
    };
  }

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

    if (parsedValue.data) inputData[field.key] = parsedValue.data;
  }

  let execution: Awaited<ReturnType<typeof executeWorkflowSteps>>;
  try {
    execution = await executeWorkflowSteps({
      workflowId: publicWorkflow.id,
      workflowName: publicWorkflow.name,
      steps: publicWorkflow.workflow.steps,
      inputValues: inputData,
      mode: "public-form",
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
    return {
      status: "error",
      message: "We couldn’t generate the document. Please try again.",
    };
  }

  const { error } = await publicWorkflow.admin.from("workflow_executions").insert({
    workflow_id: publicWorkflow.id,
    input_data: execution.inputData as Json,
    output_data: execution.outputData as Json,
  });

  if (error) {
    console.error("Public execution insert failed", {
      code: error.code,
      message: error.message,
    });
    return {
      status: "error",
      message: "We couldn’t process this submission. Please try again.",
    };
  }

  return {
    status: "success",
    message: "Thank you! Your submission has been processed.",
  };
}
