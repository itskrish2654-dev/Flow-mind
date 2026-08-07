import "server-only";

import { z } from "zod";

import { createPublicFormDefinition } from "@/lib/public-form";
import {
  CompiledWorkflowSchema,
  PublicFormDefinitionSchema,
} from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPublicClient } from "@/lib/supabase/public";

const WorkflowIdSchema = z.string().uuid();

export async function getPublicWorkflow(workflowId: string) {
  const parsedId = WorkflowIdSchema.safeParse(workflowId);
  if (!parsedId.success) return null;

  const supabase = createPublicClient();
  const { data, error } = await supabase
    .rpc("get_public_workflow", { p_workflow_id: parsedId.data })
    .maybeSingle();

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

export async function getPublicExecutableWorkflow(workflowId: string) {
  const publicWorkflow = await getPublicWorkflow(workflowId);
  if (!publicWorkflow) return null;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("workflows")
      .select("user_id, compiled_steps")
      .eq("id", publicWorkflow.id)
      .eq("public_form_enabled", true)
      .maybeSingle();

    const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
    if (error || !data?.user_id || !parsed.success) return null;

    return {
      ...publicWorkflow,
      ownerId: data.user_id,
      workflow: parsed.data,
      admin,
    };
  } catch (error: unknown) {
    console.error("Public executable workflow lookup failed", error);
    return null;
  }
}
