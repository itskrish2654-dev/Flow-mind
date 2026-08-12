import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { annotateWorkflowCapabilities } from "@/lib/capability-registry";
import { CompiledWorkflowSchema, type CompiledWorkflow } from "@/lib/schemas/workflow";
import type { Database, Json } from "@/lib/supabase/types";

export type WorkflowChangeScope =
  | "presentation"
  | "form_schema"
  | "ai_instructions"
  | "destination"
  | "workflow_structure"
  | "setup"
  | "full_replacement"
  | "rollback";

export type WorkflowSnapshot = {
  workflowId: string;
  versionId: string;
  versionNumber: number;
  name: string;
  prompt: string;
  published: boolean;
  lifecycleState: "active" | "disabled" | "archived";
  workflow: CompiledWorkflow;
  setupConfig: Record<string, string>;
};

export function sanitizeSetupConfig(
  input: Record<string, string>,
  sensitive: (key: string) => boolean,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) => !sensitive(key) && value.trim().length > 0)
      .slice(0, 100)
      .map(([key, value]) => [key.slice(0, 160), value.slice(0, 10_000)]),
  );
}

export async function loadWorkflowSnapshot(
  admin: SupabaseClient<Database>,
  workflowId: string,
  userId: string,
): Promise<WorkflowSnapshot | null> {
  const { data: identity, error } = await admin
    .from("workflows")
    .select("id, name, prompt, public_form_enabled, lifecycle_state, current_version_id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !identity?.current_version_id || identity.lifecycle_state === "archived") return null;

  const { data: version, error: versionError } = await admin
    .from("workflow_versions")
    .select("id, version_number, compiled_workflow, setup_config")
    .eq("id", identity.current_version_id)
    .eq("workflow_id", identity.id)
    .eq("user_id", userId)
    .maybeSingle();
  const parsed = CompiledWorkflowSchema.safeParse(version?.compiled_workflow);
  if (versionError || !version || !parsed.success) return null;
  const setup = version.setup_config;
  return {
    workflowId: identity.id,
    versionId: version.id,
    versionNumber: version.version_number,
    name: identity.name,
    prompt: identity.prompt,
    published: identity.public_form_enabled,
    lifecycleState: identity.lifecycle_state,
    workflow: annotateWorkflowCapabilities(parsed.data),
    setupConfig:
      setup && typeof setup === "object" && !Array.isArray(setup)
        ? Object.fromEntries(Object.entries(setup).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {},
  };
}

export async function createImmutableWorkflowVersion(
  admin: SupabaseClient<Database>,
  input: {
    workflowId: string;
    userId: string;
    expectedVersionId: string;
    workflow: CompiledWorkflow;
    setupConfig: Record<string, string>;
    scope: WorkflowChangeScope;
    summary: string;
    sourceVersionId?: string | null;
  },
): Promise<{ versionId: string; versionNumber: number }> {
  const definition = annotateWorkflowCapabilities(CompiledWorkflowSchema.parse(input.workflow));
  const { data, error } = await admin.rpc("create_workflow_version", {
    p_workflow_id: input.workflowId,
    p_user_id: input.userId,
    p_expected_version_id: input.expectedVersionId,
    p_compiled_workflow: definition as unknown as Json,
    p_setup_config: input.setupConfig as Json,
    p_change_scope: input.scope,
    p_change_summary: input.summary.slice(0, 300),
    p_source_version_id: input.sourceVersionId ?? null,
  });
  const version = data?.[0];
  if (error || !version) {
    if (error?.message.toLowerCase().includes("version conflict")) {
      throw new Error("This automation changed in another tab. Refresh before saving again.");
    }
    throw new Error(`Workflow version could not be saved: ${error?.message ?? "unknown error"}`);
  }
  return { versionId: version.version_id, versionNumber: version.version_number };
}
