"use server";

import { z } from "zod";

import type { PublicFormSubmissionState } from "@/lib/public-form";
import { getPublicWorkflow } from "@/lib/public-workflow";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import type { Json } from "@/lib/supabase/types";
import { createPublicClient } from "@/lib/supabase/public";
import { executeWorkflowSteps } from "@/lib/workflow-execution";

const WorkflowIdSchema = z.string().uuid();
const FieldValueSchema = z.string().trim().max(5_000);

function nativeFormSteps(workflowName: string): CompiledWorkflow["steps"] {
  return [
    {
      id: "native_form",
      type: "webhook_trigger",
      title: "Hosted Form Submission",
      description: "Receives validated information from the hosted form.",
    },
    {
      id: "native_process",
      type: "ai_transform",
      title: workflowName,
      description: "Processes the submitted information using this automation.",
    },
    {
      id: "native_table",
      type: "http_request",
      title: "Save to FlowMind Data",
      description: "Stores the result in the project execution table.",
    },
  ];
}

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

  const publicWorkflow = await getPublicWorkflow(parsedId.data);
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

  const execution = await executeWorkflowSteps({
    workflowId: publicWorkflow.id,
    workflowName: publicWorkflow.name,
    steps: nativeFormSteps(publicWorkflow.workflowName),
    inputValues: inputData,
    mode: "public-form",
  });

  const supabase = createPublicClient();
  const { error } = await supabase.from("workflow_executions").insert({
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
