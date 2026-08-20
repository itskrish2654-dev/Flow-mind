import "server-only";

import { z } from "zod";

import { assessWorkflowCapabilities } from "@/lib/capability-registry";
import { createPublicFormDefinition } from "@/lib/public-form";
import {
  CompiledWorkflowSchema,
  PublicFormDefinitionSchema,
} from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPublicClient } from "@/lib/supabase/public";
import { securityLog } from "@/lib/security/redaction";

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
      securityLog("Public workflow lookup failed", {
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
    challengeMode: data.challenge_mode,
  };
}

export async function getPublicExecutableWorkflow(workflowId: string) {
  const publicWorkflow = await getPublicWorkflow(workflowId);
  if (!publicWorkflow) return null;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("workflows")
      .select("user_id, current_version_id, lifecycle_state")
      .eq("id", publicWorkflow.id)
      .eq("public_form_enabled", true)
      .maybeSingle();

    if (error || !data?.user_id || !data.current_version_id || data.lifecycle_state !== "active") return null;
    const { data: version, error: versionError } = await admin
      .from("workflow_versions")
      .select("id, compiled_workflow, setup_config")
      .eq("id", data.current_version_id)
      .eq("workflow_id", publicWorkflow.id)
      .eq("user_id", data.user_id)
      .maybeSingle();
    const parsed = CompiledWorkflowSchema.safeParse(version?.compiled_workflow);
    if (versionError || !version || !parsed.success) return null;
    const unavailable = assessWorkflowCapabilities(
      parsed.data.steps,
      "production",
    ).find(({ assessment }) => !assessment.available);

    return {
      ...publicWorkflow,
      ownerId: data.user_id,
      versionId: version.id,
      workflow: parsed.data,
      setupConfig: version.setup_config && typeof version.setup_config === "object" && !Array.isArray(version.setup_config)
        ? Object.fromEntries(Object.entries(version.setup_config).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {},
      capabilityError: unavailable?.assessment.message ?? null,
      admin,
    };
  } catch (error: unknown) {
    securityLog("Public executable workflow lookup failed", { error });
    return null;
  }
}
