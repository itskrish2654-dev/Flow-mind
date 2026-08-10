import "server-only";

import { z } from "zod";

import { assessWorkflowCapabilities } from "@/lib/capability-registry";
import { createPublicFormDefinition } from "@/lib/public-form";
import type { PublicFormTrace } from "@/lib/public-form-trace";
import {
  CompiledWorkflowSchema,
  PublicFormDefinitionSchema,
} from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPublicClient } from "@/lib/supabase/public";

const WorkflowIdSchema = z.string().uuid();

export async function getPublicWorkflow(
  workflowId: string,
  trace?: PublicFormTrace,
) {
  const parsedId = WorkflowIdSchema.safeParse(workflowId);
  if (!parsedId.success) return null;

  const supabase = createPublicClient();
  trace?.("PUBLIC_WORKFLOW_RPC_START");
  const { data, error } = await supabase
    .rpc("get_public_workflow", { p_workflow_id: parsedId.data })
    .maybeSingle();
  trace?.("PUBLIC_WORKFLOW_RPC_END", { ok: !error && Boolean(data) });

  if (error || !data) {
    if (error) {
      console.error("Public workflow lookup failed", {
        code: error.code,
        message: error.message,
      });
    }
    return null;
  }

  const savedForm = PublicFormDefinitionSchema.safeParse(data.public_form);
  const form = savedForm.success
    ? savedForm.data
    : createPublicFormDefinition(
        `${data.workflow_name} ${data.summary}`,
        data.workflow_name,
        data.summary,
      );

  return {
    id: data.id,
    name: data.name,
    workflowName: data.workflow_name,
    summary: data.summary,
    form,
  };
}

export async function getPublicExecutableWorkflow(
  workflowId: string,
  trace?: PublicFormTrace,
) {
  const publicWorkflow = await getPublicWorkflow(workflowId, trace);
  if (!publicWorkflow) return null;

  try {
    const admin = createAdminClient();
    trace?.("EXECUTABLE_WORKFLOW_SELECT_START");
    const { data, error } = await admin
      .from("workflows")
      .select("user_id, compiled_steps")
      .eq("id", publicWorkflow.id)
      .eq("public_form_enabled", true)
      .maybeSingle();
    trace?.("EXECUTABLE_WORKFLOW_SELECT_END", {
      ok: !error && Boolean(data?.user_id),
    });

    const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
    if (error || !data?.user_id || !parsed.success) return null;
    const unavailable = assessWorkflowCapabilities(
      parsed.data.steps,
      "production",
    ).find(({ assessment }) => !assessment.available);

    return {
      ...publicWorkflow,
      ownerId: data.user_id,
      workflow: parsed.data,
      capabilityError: unavailable?.assessment.message ?? null,
      admin,
    };
  } catch (error: unknown) {
    console.error("Public executable workflow lookup failed", error);
    return null;
  }
}
