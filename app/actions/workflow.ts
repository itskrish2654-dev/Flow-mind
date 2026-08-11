"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import {
  annotateWorkflowCapabilities,
  assessWorkflowCapabilities,
  resolveStepCapabilityId,
} from "@/lib/capability-registry";
import { GENERATED_DOCUMENTS_BUCKET } from "@/lib/document-storage";
import type { Json } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PLAN_ENTITLEMENTS,
  SECURITY_LIMITS,
  SecurityGateError,
  enforceRateLimit,
} from "@/lib/security/limits";
import { resolveTrustedWebhook } from "@/lib/security/outbound-webhook";
import { securityLog } from "@/lib/security/redaction";
import {
  CompiledWorkflowSchema,
  DataTableDefinitionSchema,
  PublicFormDefinitionSchema,
  type CompiledWorkflow,
  type DataTableDefinition,
  type PublicFormDefinition,
} from "@/lib/schemas/workflow";
import { compileReadyPlan } from "@/lib/workflow-compiler";
import {
  planWorkflow,
  type PlanningStatus,
  type WorkflowPlan,
} from "@/lib/workflow-planner";

const MAX_PROMPT_LENGTH = 10_000;

export type CompileWorkflowResult =
  | {
      success: true;
      status: "READY_TO_COMPILE";
      id: string;
      workflow: CompiledWorkflow;
      planning: WorkflowPlan;
    }
  | {
      success: false;
      status: Exclude<PlanningStatus, "READY_TO_COMPILE"> | "ERROR";
      error: string;
      planning?: WorkflowPlan;
      requestedCapability?: string;
    };

export type GetWorkflowResult =
  | {
      ok: true;
      workflow: CompiledWorkflow | null;
      name: string;
      prompt: string;
      published: boolean;
    }
  | { ok: false; error: string };

export type SavedWorkflow = {
  id: string;
  name: string;
  prompt: string;
  workflow: CompiledWorkflow | null;
};

export type ListWorkflowsResult =
  | { ok: true; workflows: SavedWorkflow[] }
  | { ok: false; error: string };

export type DeleteWorkflowResult =
  | { ok: true }
  | { ok: false; error: string };

export type SaveDocumentTemplateResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; error: string };

export type SaveWorkflowCustomizationResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; error: string };

export type WorkflowPublicationResult =
  | { ok: true; published: boolean }
  | { ok: false; error: string };

export async function saveWorkflowCustomization(
  workflowId: string,
  customization: {
    publicForm?: PublicFormDefinition;
    dataTable?: DataTableDefinition;
  },
): Promise<SaveWorkflowCustomizationResult> {
  const request = z
    .object({
      workflowId: z.string().uuid(),
      customization: z
        .object({
          publicForm: PublicFormDefinitionSchema.optional(),
          dataTable: DataTableDefinitionSchema.optional(),
        })
        .refine((value) => value.publicForm || value.dataTable, {
          message: "Choose something to customize before saving.",
        }),
    })
    .safeParse({ workflowId, customization });

  if (!request.success) {
    return {
      ok: false,
      error: request.error.issues[0]?.message ?? "The customization is invalid.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();

  const { data, error } = await auth.supabase
    .from("workflows")
    .select("compiled_steps")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
  if (error || !parsed.success) {
    return { ok: false, error: "We couldn't find this workflow." };
  }

  const workflow = annotateWorkflowCapabilities(
    CompiledWorkflowSchema.parse({
      ...parsed.data,
      ...(request.data.customization.publicForm
        ? { publicForm: request.data.customization.publicForm }
        : {}),
      ...(request.data.customization.dataTable
        ? { dataTable: request.data.customization.dataTable }
        : {}),
    }),
  );
  const { error: updateError } = await admin
    .from("workflows")
    .update({ compiled_steps: workflow })
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id);

  if (updateError) {
    securityLog("Workflow customization persistence failed", {
      code: updateError.code,
      message: updateError.message,
    });
    return { ok: false, error: "We couldn't save these changes." };
  }

  revalidatePath(`/f/${request.data.workflowId}`);
  revalidatePath(`/dashboard/projects/${request.data.workflowId}`);
  return { ok: true, workflow };
}

export async function saveDocumentTemplate(
  workflowId: string,
  stepId: string,
  template: string,
): Promise<SaveDocumentTemplateResult> {
  const request = z
    .object({
      workflowId: z.string().uuid(),
      stepId: z.string().min(1).max(100),
      template: z.string().trim().min(1).max(50_000),
    })
    .safeParse({ workflowId, stepId, template });
  if (!request.success) {
    return { ok: false, error: "Add a document template before saving." };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();
  const { data, error } = await auth.supabase
    .from("workflows")
    .select("compiled_steps")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
  if (error || !parsed.success) {
    return { ok: false, error: "We couldn't find this document workflow." };
  }

  let matchedStep = false;
  const workflow = annotateWorkflowCapabilities({
    ...parsed.data,
    steps: parsed.data.steps.map((step) => {
      if (step.id !== request.data.stepId || step.type !== "generate_pdf") {
        return step;
      }
      matchedStep = true;
      return {
        ...step,
        config: { ...step.config, documentTemplate: request.data.template },
      };
    }),
  });
  if (!matchedStep) {
    return { ok: false, error: "We couldn't find the PDF step to update." };
  }

  const { error: updateError } = await admin
    .from("workflows")
    .update({ compiled_steps: workflow })
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id);
  if (updateError) {
    securityLog("Document template persistence failed", {
      code: updateError.code,
      message: updateError.message,
    });
    return { ok: false, error: "We couldn't save the document template." };
  }
  return { ok: true, workflow };
}

export async function deleteWorkflow(
  workflowId: string,
): Promise<DeleteWorkflowResult> {
  const parsedWorkflowId = z.string().uuid().safeParse(workflowId);
  if (!parsedWorkflowId.success) {
    return { ok: false, error: "We could not identify that automation." };
  }
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();
  try {
    const { data: documents, error: documentsError } = await admin
      .from("generated_document_records")
      .select("storage_path")
      .eq("workflow_id", parsedWorkflowId.data)
      .eq("user_id", auth.user.id);
    if (documentsError) throw new Error("Document cleanup lookup failed.");
    const paths = (documents ?? []).map((document) => document.storage_path);
    if (paths.length > 0) {
      const { error: removalError } = await admin.storage
        .from(GENERATED_DOCUMENTS_BUCKET)
        .remove(paths);
      if (removalError) throw new Error("Document cleanup failed.");
    }
  } catch (error) {
    securityLog("Workflow document cleanup failed", {
      error,
      workflowId: parsedWorkflowId.data,
    });
    return { ok: false, error: "We couldn't safely remove that automation's documents." };
  }
  const { error } = await admin
    .from("workflows")
    .delete()
    .eq("id", parsedWorkflowId.data)
    .eq("user_id", auth.user.id);
  if (error) {
    securityLog("Workflow deletion failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn't delete that automation. Please try again." };
  }
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function listWorkflows(): Promise<ListWorkflowsResult> {
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const { data, error } = await auth.supabase
    .from("workflows")
    .select("id, name, prompt, compiled_steps")
    .eq("user_id", auth.user.id)
    .limit(30);
  if (error) {
    securityLog("Workflow list failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn't load your automations." };
  }

  const workflows: SavedWorkflow[] = (data ?? []).map((row) => {
    const parsed = CompiledWorkflowSchema.safeParse(row.compiled_steps);
    if (row.compiled_steps !== null && !parsed.success) {
      securityLog("Saved workflow list item could not be read", {
        workflowId: row.id,
        issues: parsed.error.issues,
      });
    }
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      workflow: parsed.success ? annotateWorkflowCapabilities(parsed.data) : null,
    };
  });
  return { ok: true, workflows };
}

export async function compileWorkflow(
  prompt: string,
  existingWorkflowId: string | null = null,
): Promise<CompileWorkflowResult> {
  const normalizedPrompt = prompt.trim();
  const parsedExistingWorkflowId = existingWorkflowId
    ? z.string().uuid().safeParse(existingWorkflowId)
    : null;
  if (!normalizedPrompt) {
    const planning = planWorkflow(normalizedPrompt);
    return {
      success: false,
      status: "NEEDS_CLARIFICATION",
      error: planning.message,
      planning,
    };
  }
  if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      success: false,
      status: "ERROR",
      error: "Workflow descriptions must be 10,000 characters or fewer.",
    };
  }
  if (parsedExistingWorkflowId && !parsedExistingWorkflowId.success) {
    return {
      success: false,
      status: "ERROR",
      error: "We could not identify that draft automation.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { success: false, status: "ERROR", error: "Unauthorized" };

  try {
    await enforceRateLimit(
      "workflow-planning",
      [auth.user.id],
      SECURITY_LIMITS.planning,
    );
  } catch (error) {
    return {
      success: false,
      status: "ERROR",
      error:
        error instanceof SecurityGateError
          ? error.message
          : "This request cannot be accepted safely right now.",
    };
  }

  const planning = planWorkflow(normalizedPrompt);
  if (planning.status !== "READY_TO_COMPILE") {
    return {
      success: false,
      status: planning.status,
      error: planning.message,
      planning,
      ...(planning.requestedUnsupportedCapabilities[0]
        ? {
            requestedCapability:
              planning.requestedUnsupportedCapabilities[0].capabilityId,
          }
        : {}),
    };
  }

  let compiledWorkflow: CompiledWorkflow;
  try {
    compiledWorkflow = compileReadyPlan(normalizedPrompt, planning);
  } catch (error: unknown) {
    securityLog("Deterministic compiler failed", { error });
    return {
      success: false,
      status: "ERROR",
      error: "FlowMind could not safely compile this workflow.",
    };
  }

  const workflowValues = {
    user_id: auth.user.id,
    name: compiledWorkflow.workflowName.slice(0, 80),
    prompt: normalizedPrompt,
    compiled_steps: compiledWorkflow,
    public_form_enabled: false,
    published_at: null,
  };
  const admin = createAdminClient();
  let data: { id: string } | null = null;
  let error: { code?: string; message: string; details?: string; hint?: string } | null = null;
  if (parsedExistingWorkflowId?.success) {
    const result = await admin
      .from("workflows")
      .update(workflowValues)
      .eq("id", parsedExistingWorkflowId.data)
      .eq("user_id", auth.user.id)
      .select("id")
      .single();
    data = result.data;
    error = result.error;
  } else {
    const result = await admin.rpc("create_workflow_with_quota", {
      p_user_id: auth.user.id,
      p_name: workflowValues.name,
      p_prompt: workflowValues.prompt,
      p_compiled_steps: compiledWorkflow as unknown as Json,
      p_limit: PLAN_ENTITLEMENTS.free.workflows,
    });
    data = result.data ? { id: result.data } : null;
    error = result.error;
    if (!error && !data) {
      return {
        success: false,
        status: "ERROR",
        error: "This account has reached its workflow limit.",
      };
    }
  }
  if (error) {
    securityLog("Compiled workflow persistence failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return {
      success: false,
      status: "ERROR",
      error: "The workflow compiled, but it could not be saved to the database.",
    };
  }
  if (!data?.id) {
    return {
      success: false,
      status: "ERROR",
      error: "The workflow was saved without an identifier.",
    };
  }

  revalidatePath("/dashboard");
  return {
    success: true,
    status: "READY_TO_COMPILE",
    id: data.id,
    workflow: compiledWorkflow,
    planning,
  };
}

export async function getWorkflow(workflowId: string): Promise<GetWorkflowResult> {
  const parsedWorkflowId = z.string().uuid().safeParse(workflowId);
  if (!parsedWorkflowId.success) {
    return { ok: false, error: "We could not find this automation." };
  }
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const { data, error } = await auth.supabase
    .from("workflows")
    .select("name, prompt, compiled_steps, public_form_enabled")
    .eq("id", parsedWorkflowId.data)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, error: "We could not find this automation." };
  }
  if (data.compiled_steps === null) {
    return {
      ok: true,
      workflow: null,
      name: data.name,
      prompt: data.prompt,
      published: data.public_form_enabled,
    };
  }
  const parsedWorkflow = CompiledWorkflowSchema.safeParse(data.compiled_steps);
  if (!parsedWorkflow.success) {
    securityLog("Saved workflow could not be read", {
      workflowId: parsedWorkflowId.data,
      issues: parsedWorkflow.error.issues,
    });
    return { ok: false, error: "This automation needs to be created again." };
  }
  return {
    ok: true,
    workflow: annotateWorkflowCapabilities(parsedWorkflow.data),
    name: data.name,
    prompt: data.prompt,
    published: data.public_form_enabled,
  };
}

export async function setWorkflowPublication(
  workflowId: string,
  publish: boolean,
): Promise<WorkflowPublicationResult> {
  const parsedId = z.string().uuid().safeParse(workflowId);
  if (!parsedId.success) return { ok: false, error: "Workflow not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();
  const { data, error } = await auth.supabase
    .from("workflows")
    .select("compiled_steps")
    .eq("id", parsedId.data)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Workflow not found." };
  if (publish) {
    const workflow = CompiledWorkflowSchema.safeParse(data.compiled_steps);
    if (!workflow.success || !workflow.data.publicForm) {
      return { ok: false, error: "Add a hosted form before publishing." };
    }
    const unavailable = assessWorkflowCapabilities(workflow.data.steps, "production")
      .find(({ assessment }) => !assessment.available);
    if (unavailable) {
      return {
        ok: false,
        error: unavailable.assessment.message ?? "This workflow cannot be published safely.",
      };
    }
  }
  const { error: updateError } = await admin
    .from("workflows")
    .update({
      public_form_enabled: publish,
      published_at: publish ? new Date().toISOString() : null,
    })
    .eq("id", parsedId.data)
    .eq("user_id", auth.user.id);
  if (updateError) return { ok: false, error: "Publication status could not be changed." };
  revalidatePath(`/f/${parsedId.data}`);
  revalidatePath(`/dashboard/projects/${parsedId.data}`);
  return { ok: true, published: publish };
}

export async function saveWebhookEndpoint(
  workflowId: string,
  stepId: string,
  endpoint: string,
): Promise<SaveDocumentTemplateResult> {
  const request = z.object({
    workflowId: z.string().uuid(),
    stepId: z.string().min(1).max(100),
    endpoint: z.string().trim().max(2_000),
  }).safeParse({ workflowId, stepId, endpoint });
  if (!request.success) return { ok: false, error: "Webhook configuration is invalid." };

  // Authenticate and establish ownership before any DNS or endpoint work.
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();
  const { data } = await auth.supabase
    .from("workflows")
    .select("compiled_steps")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
  if (!parsed.success) return { ok: false, error: "Workflow not found." };
  const registeredStep = parsed.data.steps.find(
    (step) =>
      step.id === request.data.stepId &&
      resolveStepCapabilityId(step) === "webhook_post",
  );
  if (!registeredStep) return { ok: false, error: "Webhook step not found." };

  try {
    await resolveTrustedWebhook(request.data.endpoint);
  } catch {
    return { ok: false, error: "Use a public HTTPS webhook URL. Private and redirected destinations are blocked." };
  }

  const workflow = annotateWorkflowCapabilities({
    ...parsed.data,
    steps: parsed.data.steps.map((step) => {
      if (step.id !== registeredStep.id) return step;
      return { ...step, config: { ...step.config, endpoint: request.data.endpoint, method: "POST" as const } };
    }),
  });
  const { error } = await admin
    .from("workflows")
    .update({ compiled_steps: workflow })
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id);
  if (error) return { ok: false, error: "Webhook configuration could not be saved." };
  return { ok: true, workflow };
}
