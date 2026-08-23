"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { CompiledWorkflowSchema } from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { createImmutableWorkflowVersion, loadWorkflowSnapshot } from "@/lib/workflow-versioning";

export type WorkflowVersionSummary = {
  id: string;
  versionNumber: number;
  scope: string;
  summary: string | null;
  createdAt: string;
  current: boolean;
};

export async function listWorkflowVersions(workflowId: string): Promise<
  | { ok: true; versions: WorkflowVersionSummary[] }
  | { ok: false; error: string }
> {
  const id = z.string().uuid().safeParse(workflowId);
  if (!id.success) return { ok: false, error: "Workflow not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };
  const admin = createAdminClient();
  const snapshot = await loadWorkflowSnapshot(admin, id.data, auth.user.id);
  if (!snapshot) return { ok: false, error: "Workflow not found." };
  const { data, error } = await admin
    .from("workflow_versions")
    .select("id, version_number, change_scope, change_summary, created_at")
    .eq("workflow_id", id.data)
    .eq("user_id", auth.user.id)
    .order("version_number", { ascending: false });
  if (error) return { ok: false, error: "Change history could not be loaded." };
  return {
    ok: true,
    versions: (data ?? []).map((version) => ({
      id: version.id,
      versionNumber: version.version_number,
      scope: version.change_scope,
      summary: version.change_summary,
      createdAt: version.created_at,
      current: version.id === snapshot.versionId,
    })),
  };
}

export async function rollbackWorkflowVersion(workflowId: string, sourceVersionId: string) {
  const request = z.object({ workflowId: z.string().uuid(), sourceVersionId: z.string().uuid() })
    .safeParse({ workflowId, sourceVersionId });
  if (!request.success) return { ok: false as const, error: "Version not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient();
  const current = await loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id);
  if (!current) return { ok: false as const, error: "Workflow not found." };
  const { data: source } = await admin
    .from("workflow_versions")
    .select("compiled_workflow, setup_config, version_number")
    .eq("id", request.data.sourceVersionId)
    .eq("workflow_id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const workflow = CompiledWorkflowSchema.safeParse(source?.compiled_workflow);
  if (!source || !workflow.success) return { ok: false as const, error: "Version not found." };
  const setup = source.setup_config && typeof source.setup_config === "object" && !Array.isArray(source.setup_config)
    ? Object.fromEntries(Object.entries(source.setup_config).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  try {
    const restored = await createImmutableWorkflowVersion(admin, {
      workflowId: request.data.workflowId,
      userId: auth.user.id,
      expectedVersionId: current.versionId,
      workflow: workflow.data,
      setupConfig: setup,
      scope: "rollback",
      summary: "Restored an earlier setup; newer history was preserved.",
      sourceVersionId: request.data.sourceVersionId,
    });
    revalidatePath(`/dashboard/projects/${request.data.workflowId}`);
    return { ok: true as const, ...restored };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Version could not be restored." };
  }
}
