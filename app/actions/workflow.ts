"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { activateWorkflowConnectorSubscriptions, connectorWebhookUrl, deactivateWorkflowConnectorSubscriptions, validateWorkflowConnectorConnections } from "@/lib/connectors/subscriptions";
import {
  annotateWorkflowCapabilities,
  assessWorkflowCapabilities,
  requiresPublicFormTurnstile,
  resolveStepCapabilityId,
} from "@/lib/capability-registry";
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
import { captureOperationalError, trackProductEvent, type ProductEventName } from "@/lib/observability";
import {
  createImmutableWorkflowVersion,
  loadWorkflowSnapshot,
  type WorkflowChangeScope,
} from "@/lib/workflow-versioning";
import {
  CompiledWorkflowSchema,
  DataTableDefinitionSchema,
  PublicFormDefinitionSchema,
  type CompiledWorkflow,
  type DataTableDefinition,
  type PublicFormDefinition,
} from "@/lib/schemas/workflow";
import { validateRequiredSetupInputs } from "@/lib/workflow-execution";
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
      versionId: string | null;
      versionNumber: number | null;
      setupConfig: Record<string, string>;
      lifecycleState: "active" | "disabled" | "archived";
    }
  | { ok: false; error: string };

export type SavedWorkflow = {
  id: string;
  name: string;
  prompt: string;
  workflow: CompiledWorkflow | null;
  createdAt: string;
  lifecycleState: "active" | "disabled" | "archived";
  readiness: "Draft" | "Ready" | "Running" | "Failed";
};

export type ListWorkflowsResult =
  | { ok: true; workflows: SavedWorkflow[]; nextCursor: string | null }
  | { ok: false; error: string };

export type DeleteWorkflowResult =
  | { ok: true }
  | { ok: false; error: string };

export type SaveDocumentTemplateResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; error: string };

export type SaveWorkflowCustomizationResult =
  | { ok: true; workflow: CompiledWorkflow }
  | {
      ok: false;
      error: string;
      impact?: { removedFields: string[]; affectedExecutionCount: number };
    };

export type WorkflowPublicationResult =
  | { ok: true; published: boolean; connectorEndpoints: string[] }
  | { ok: false; error: string };

async function saveVersionedWorkflowChange(input: {
  workflowId: string;
  userId: string;
  workflow: CompiledWorkflow;
  scope: WorkflowChangeScope;
  summary: string;
  setupConfig?: Record<string, string>;
}) {
  const admin = createAdminClient();
  const snapshot = await loadWorkflowSnapshot(admin, input.workflowId, input.userId);
  if (!snapshot) throw new Error("We couldn't find this workflow.");
  await createImmutableWorkflowVersion(admin, {
    workflowId: input.workflowId,
    userId: input.userId,
    expectedVersionId: snapshot.versionId,
    workflow: input.workflow,
    setupConfig: input.setupConfig ?? snapshot.setupConfig,
    scope: input.scope,
    summary: input.summary,
  });
}

export async function saveWorkflowCustomization(
  workflowId: string,
  customization: {
    publicForm?: PublicFormDefinition;
    dataTable?: DataTableDefinition;
    confirmDestructiveFieldRemoval?: boolean;
  },
): Promise<SaveWorkflowCustomizationResult> {
  const request = z
    .object({
      workflowId: z.string().uuid(),
      customization: z
        .object({
          publicForm: PublicFormDefinitionSchema.optional(),
          dataTable: DataTableDefinitionSchema.optional(),
          confirmDestructiveFieldRemoval: z.boolean().optional(),
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
  const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id);
  const parsed = CompiledWorkflowSchema.safeParse(snapshot?.workflow);
  if (!snapshot || !parsed.success) {
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
  if (request.data.customization.publicForm && parsed.data.publicForm) {
    const nextKeys = new Set(request.data.customization.publicForm.fields.map((field) => field.key));
    const removedFields = parsed.data.publicForm.fields
      .map((field) => field.key)
      .filter((key) => !nextKeys.has(key));
    if (removedFields.length > 0 && !request.data.customization.confirmDestructiveFieldRemoval) {
      let affectedExecutionCount = 0;
      for (const key of removedFields) {
        const { count, error: countError } = await admin
          .from("workflow_executions")
          .select("id", { count: "exact", head: true })
          .eq("workflow_id", request.data.workflowId)
          .eq("user_id", auth.user.id)
          .not(`input_data->>${key}`, "is", null);
        if (countError) return { ok: false, error: "Field-removal impact could not be checked safely." };
        affectedExecutionCount += count ?? 0;
      }
      if (affectedExecutionCount > 0) {
        return {
          ok: false,
          error: `Removing ${removedFields.join(", ")} affects ${affectedExecutionCount} stored value${affectedExecutionCount === 1 ? "" : "s"}. Existing execution data will remain recoverable in history.`,
          impact: { removedFields, affectedExecutionCount },
        };
      }
    }
  }
  try {
    await saveVersionedWorkflowChange({
      workflowId: request.data.workflowId,
      userId: auth.user.id,
      workflow,
      scope: request.data.customization.publicForm ? "form_schema" : "presentation",
      summary: request.data.customization.publicForm
        ? "Updated hosted form configuration."
        : "Updated execution data table presentation.",
    });
  } catch (updateError) {
    securityLog("Workflow customization persistence failed", {
      error: updateError,
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
  const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id);
  const parsed = CompiledWorkflowSchema.safeParse(snapshot?.workflow);
  if (!snapshot || !parsed.success) {
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

  try {
    await saveVersionedWorkflowChange({
      workflowId: request.data.workflowId,
      userId: auth.user.id,
      workflow,
      scope: "ai_instructions",
      summary: "Updated PDF document template.",
    });
  } catch (updateError) {
    securityLog("Document template persistence failed", {
      error: updateError,
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
  const { error } = await admin
    .from("workflows")
    .update({
      lifecycle_state: "archived",
      archived_at: new Date().toISOString(),
      public_form_enabled: false,
      published_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsedWorkflowId.data)
    .eq("user_id", auth.user.id);
  if (error) {
    securityLog("Workflow deletion failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn't archive that automation. Please try again." };
  }
  try {
    await deactivateWorkflowConnectorSubscriptions(auth.user.id, parsedWorkflowId.data);
  } catch (subscriptionError) {
    securityLog("Archived workflow subscription cleanup failed", { error: subscriptionError, workflowId: parsedWorkflowId.data });
  }
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function listWorkflows(cursor?: string | null): Promise<ListWorkflowsResult> {
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const parsedCursor = cursor
    ? z.string().regex(/^\d{4}-\d{2}-\d{2}T.+\|[0-9a-f-]{36}$/).safeParse(cursor)
    : null;
  if (parsedCursor && !parsedCursor.success) return { ok: false, error: "Invalid workflow cursor." };
  let query = auth.supabase
    .from("workflows")
    .select("id, name, prompt, compiled_steps, created_at, lifecycle_state, current_version_id")
    .eq("user_id", auth.user.id)
    .neq("lifecycle_state", "archived")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(31);
  if (parsedCursor?.success) {
    const [createdAt, id] = parsedCursor.data.split("|");
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
  }
  const { data, error } = await query;
  if (error) {
    securityLog("Workflow list failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn't load your automations." };
  }

  const page = (data ?? []).slice(0, 30);
  const versionIds = page.flatMap((row) => row.current_version_id ? [row.current_version_id] : []);
  const workflowIds = page.map((row) => row.id);
  const [{ data: versions }, { data: executions }] = await Promise.all([
    versionIds.length > 0
      ? auth.supabase.from("workflow_versions").select("id, setup_config").in("id", versionIds)
      : Promise.resolve({ data: [] }),
    workflowIds.length > 0
      ? auth.supabase.from("workflow_executions")
          .select("workflow_id, status, created_at, id")
          .in("workflow_id", workflowIds)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);
  const setupByVersion = new Map((versions ?? []).map((version) => [version.id, version.setup_config]));
  const latestExecution = new Map<string, { status: string }>();
  for (const execution of executions ?? []) {
    if (!latestExecution.has(execution.workflow_id)) latestExecution.set(execution.workflow_id, execution);
  }
  const workflows: SavedWorkflow[] = page.map((row) => {
    const parsed = CompiledWorkflowSchema.safeParse(row.compiled_steps);
    if (row.compiled_steps !== null && !parsed.success) {
      securityLog("Saved workflow list item could not be read", {
        workflowId: row.id,
        issues: parsed.error.issues,
      });
    }
    const setupValue = row.current_version_id ? setupByVersion.get(row.current_version_id) : null;
    const setup = setupValue && typeof setupValue === "object" && !Array.isArray(setupValue)
      ? Object.fromEntries(Object.entries(setupValue).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const latest = latestExecution.get(row.id)?.status;
    const unavailable = !parsed.success || assessWorkflowCapabilities(parsed.data.steps, "test").some(({ assessment }) => !assessment.available);
    const incomplete = parsed.success ? Boolean(validateRequiredSetupInputs(parsed.data.steps, setup)) : true;
    const readiness: SavedWorkflow["readiness"] = latest === "queued" || latest === "running"
      ? "Running"
      : latest === "failed" || latest === "partially_failed"
        ? "Failed"
        : unavailable || incomplete || row.lifecycle_state !== "active"
          ? "Draft"
          : "Ready";
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      workflow: parsed.success ? annotateWorkflowCapabilities(parsed.data) : null,
      createdAt: row.created_at,
      lifecycleState: row.lifecycle_state,
      readiness,
    };
  });
  const last = page.at(-1);
  return {
    ok: true,
    workflows,
    nextCursor: (data?.length ?? 0) > 30 && last ? `${last.created_at}|${last.id}` : null,
  };
}

export async function compileWorkflow(
  prompt: string,
  existingWorkflowId: string | null = null,
  editIntent?: "modify" | "replace",
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
  if (parsedExistingWorkflowId?.success && !editIntent) {
    return {
      success: false,
      status: "NEEDS_CLARIFICATION",
      error: "Choose Modify current automation or Replace current automation before applying this prompt.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { success: false, status: "ERROR", error: "Unauthorized" };
  await trackProductEvent({
    event: "prompt_submitted",
    userId: auth.user.id,
    workflowId: parsedExistingWorkflowId?.success ? parsedExistingWorkflowId.data : null,
    properties: { source: parsedExistingWorkflowId?.success ? "workflow_edit" : "dashboard" },
  });

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
  const plannerEvent: Record<PlanningStatus, ProductEventName> = {
    READY_TO_COMPILE: "planner_ready_to_compile",
    NEEDS_CLARIFICATION: "planner_needs_clarification",
    UNSUPPORTED: "planner_unsupported",
    CONFLICTING_REQUIREMENTS: "planner_conflicting_requirements",
  };
  await trackProductEvent({
    event: plannerEvent[planning.status],
    userId: auth.user.id,
    workflowId: parsedExistingWorkflowId?.success ? parsedExistingWorkflowId.data : null,
    properties: {
      planner_status: planning.status,
      step_count: planning.status === "READY_TO_COMPILE"
        ? Number(Boolean(planning.trigger)) + planning.transformations.length + Number(Boolean(planning.destination))
        : 0,
    },
  });
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
    await captureOperationalError({
      event: "workflow_compilation_failed",
      error,
      userId: auth.user.id,
      errorCategory: "compiler",
      status: "failed",
    });
    return {
      success: false,
      status: "ERROR",
      error: "CrazyLoops could not safely compile this workflow.",
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
    const snapshot = await loadWorkflowSnapshot(admin, parsedExistingWorkflowId.data, auth.user.id);
    if (!snapshot) return { success: false, status: "ERROR", error: "We couldn't find this automation." };
    try {
      await createImmutableWorkflowVersion(admin, {
        workflowId: snapshot.workflowId,
        userId: auth.user.id,
        expectedVersionId: snapshot.versionId,
        workflow: compiledWorkflow,
        setupConfig: editIntent === "replace" ? {} : snapshot.setupConfig,
        scope: editIntent === "replace" ? "full_replacement" : "workflow_structure",
        summary: editIntent === "replace" ? "Explicit full workflow replacement." : "Modified workflow structure from a prompt.",
      });
      const update = await admin.from("workflows").update({ prompt: normalizedPrompt }).eq("id", snapshot.workflowId).eq("user_id", auth.user.id);
      data = { id: snapshot.workflowId };
      error = update.error;
    } catch (versionError) {
      error = { message: versionError instanceof Error ? versionError.message : "Version creation failed." };
    }
  } else {
    const result = await admin.rpc("create_versioned_workflow_with_quota", {
      p_user_id: auth.user.id,
      p_name: workflowValues.name,
      p_prompt: workflowValues.prompt,
      p_compiled_workflow: compiledWorkflow as unknown as Json,
      p_setup_config: {},
      p_limit: PLAN_ENTITLEMENTS.free.workflows,
    });
    data = result.data?.[0] ? { id: result.data[0].workflow_id } : null;
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
  let workflowCount = 1;
  if (!parsedExistingWorkflowId?.success) {
    const { count } = await admin
      .from("workflows")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.user.id)
      .neq("lifecycle_state", "archived");
    workflowCount = count ?? 1;
  }
  await trackProductEvent({
    event: parsedExistingWorkflowId?.success ? "workflow_configured" : "workflow_created",
    userId: auth.user.id,
    workflowId: data.id,
    properties: { step_count: compiledWorkflow.steps.length, workflow_count: workflowCount },
  });
  if (!parsedExistingWorkflowId?.success && workflowCount === 2) {
    await trackProductEvent({
      event: "second_workflow_created",
      userId: auth.user.id,
      workflowId: data.id,
      properties: { workflow_count: workflowCount },
    });
  }
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
  const snapshot = await loadWorkflowSnapshot(createAdminClient(), parsedWorkflowId.data, auth.user.id);
  if (!snapshot) {
    return { ok: false, error: "We could not find this automation." };
  }
  const parsedWorkflow = CompiledWorkflowSchema.safeParse(snapshot.workflow);
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
    name: snapshot.name,
    prompt: snapshot.prompt,
    published: snapshot.published,
    versionId: snapshot.versionId,
    versionNumber: snapshot.versionNumber,
    setupConfig: snapshot.setupConfig,
    lifecycleState: snapshot.lifecycleState,
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
    .select("compiled_steps, current_version_id")
    .eq("id", parsedId.data)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Workflow not found." };
  const workflow = CompiledWorkflowSchema.safeParse(data.compiled_steps);
  let publicationSetupConfig: Record<string, string> = {};
  if (publish) {
    if (!workflow.success) {
      return { ok: false, error: "This automation needs to be created again." };
    }
    const hasConnectorTrigger = workflow.data.steps.some((step) => step.config?.connector?.operationKind === "trigger");
    if (!workflow.data.publicForm && !hasConnectorTrigger) {
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
    const snapshot = await loadWorkflowSnapshot(admin, parsedId.data, auth.user.id);
    publicationSetupConfig = snapshot?.setupConfig ?? {};
    const incomplete = validateRequiredSetupInputs(workflow.data.steps, publicationSetupConfig);
    if (incomplete) return { ok: false, error: incomplete };
    const connectorReadiness = await validateWorkflowConnectorConnections({ userId: auth.user.id, setupConfig: publicationSetupConfig, steps: workflow.data.steps });
    if (connectorReadiness) return { ok: false, error: connectorReadiness };
  }
  const { error: updateError } = await admin
    .from("workflows")
    .update({
      public_form_enabled: publish,
      public_form_challenge_mode: workflow.success && requiresPublicFormTurnstile(workflow.data.steps)
        ? "turnstile"
        : "honeypot",
      published_at: publish ? new Date().toISOString() : null,
    })
    .eq("id", parsedId.data)
    .eq("user_id", auth.user.id);
  if (updateError) return { ok: false, error: "Publication status could not be changed." };
  let connectorEndpoints: string[] = [];
  try {
    if (publish && workflow.success && data.current_version_id) {
      const subscriptions = await activateWorkflowConnectorSubscriptions({ userId: auth.user.id, workflowId: parsedId.data, workflowVersionId: data.current_version_id, setupConfig: publicationSetupConfig, steps: workflow.data.steps });
      connectorEndpoints = subscriptions.map((subscription) => subscription.url);
    } else {
      await deactivateWorkflowConnectorSubscriptions(auth.user.id, parsedId.data);
    }
  } catch (subscriptionError) {
    await admin.from("workflows").update({ public_form_enabled: false, published_at: null }).eq("id", parsedId.data).eq("user_id", auth.user.id);
    securityLog("Workflow connector publication failed", { error: subscriptionError, workflowId: parsedId.data });
    return { ok: false, error: "Connector subscriptions could not be activated safely." };
  }
  revalidatePath(`/f/${parsedId.data}`);
  revalidatePath(`/dashboard/projects/${parsedId.data}`);
  await trackProductEvent({
    event: publish ? "workflow_published" : "workflow_unpublished",
    userId: auth.user.id,
    workflowId: parsedId.data,
    properties: { published: publish },
  });
  return { ok: true, published: publish, connectorEndpoints };
}

export async function getWorkflowConnectorEndpoints(workflowId: string) {
  const parsed = z.string().uuid().safeParse(workflowId);
  if (!parsed.success) return { ok: false as const, error: "Workflow not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized" };
  const { data, error } = await createAdminClient().from("connector_subscriptions").select("id").eq("workflow_id", parsed.data).eq("user_id", auth.user.id).eq("connector_id", "flowmind_webhook").eq("status", "active");
  if (error) return { ok: false as const, error: "Connector endpoints could not be loaded." };
  try { return { ok: true as const, endpoints: (data ?? []).map((item) => connectorWebhookUrl(item.id)) }; }
  catch { return { ok: false as const, error: "Connector endpoints are not configured." }; }
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
  const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id);
  const parsed = CompiledWorkflowSchema.safeParse(snapshot?.workflow);
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
  try {
    await saveVersionedWorkflowChange({
      workflowId: request.data.workflowId,
      userId: auth.user.id,
      workflow,
      scope: "destination",
      summary: "Updated trusted webhook destination.",
    });
  } catch {
    return { ok: false, error: "Webhook configuration could not be saved." };
  }
  return { ok: true, workflow };
}
