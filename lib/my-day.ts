import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import {
  buildMyDayData,
  MY_DAY_LIMITS,
  type MyDayConnectionCandidate,
  type MyDayData,
  type MyDayExecutionCandidate,
  type MyDayWorkflowCandidate,
} from "@/lib/my-day-model";

export async function loadMyDayData(): Promise<MyDayData | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;

  const userId = auth.user.id;
  const [workflowResult, executionResult, connectionResult, credentialResult] = await Promise.all([
    auth.supabase
      .from("workflows")
      .select("id, user_id, name, lifecycle_state, current_version_id, updated_at")
      .eq("user_id", userId)
      .neq("lifecycle_state", "archived")
      .order("updated_at", { ascending: false })
      .limit(MY_DAY_LIMITS.workflows),
    auth.supabase
      .from("workflow_executions")
      .select("id, user_id, workflow_id, status, trigger_type, created_at, completed_at, failure_category")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(MY_DAY_LIMITS.executions),
    auth.supabase
      .from("connector_connections")
      .select("id, user_id, provider_family, status")
      .eq("user_id", userId)
      .neq("status", "revoked")
      .order("updated_at", { ascending: false })
      .limit(MY_DAY_LIMITS.connections),
    auth.supabase
      .from("workflow_credentials")
      .select("user_id, workflow_id, connector_id, credential_key")
      .eq("user_id", userId)
      .limit(MY_DAY_LIMITS.credentials),
  ]);

  if (workflowResult.error || executionResult.error || connectionResult.error || credentialResult.error) {
    throw new Error("My Day could not be loaded safely.");
  }

  const versionIds = workflowResult.data
    .map((workflow) => workflow.current_version_id)
    .filter((value): value is string => Boolean(value));
  const versionResult = versionIds.length > 0
    ? await auth.supabase
        .from("workflow_versions")
        .select("id, workflow_id, user_id, compiled_workflow, setup_config")
        .eq("user_id", userId)
        .in("id", versionIds)
        .limit(MY_DAY_LIMITS.workflows)
    : { data: [], error: null };

  if (versionResult.error) throw new Error("My Day could not load workflow setup safely.");

  const versionById = new Map(versionResult.data.map((version) => [version.id, version]));
  const credentialKeysByWorkflow = new Map<string, string[]>();
  for (const credential of credentialResult.data) {
    const keys = credentialKeysByWorkflow.get(credential.workflow_id) ?? [];
    keys.push(`${credential.connector_id}:${credential.credential_key}`);
    credentialKeysByWorkflow.set(credential.workflow_id, keys);
  }

  const workflows: MyDayWorkflowCandidate[] = workflowResult.data.flatMap((workflow) => {
    const version = workflow.current_version_id ? versionById.get(workflow.current_version_id) : null;
    if (!version || version.workflow_id !== workflow.id || version.user_id !== userId) return [];
    return [{
      id: workflow.id,
      userId: workflow.user_id,
      name: workflow.name,
      lifecycleState: workflow.lifecycle_state,
      updatedAt: workflow.updated_at,
      workflow: version.compiled_workflow,
      setupConfig: version.setup_config,
      configuredCredentialKeys: credentialKeysByWorkflow.get(workflow.id) ?? [],
    }];
  });
  const executions: MyDayExecutionCandidate[] = executionResult.data.map((execution) => ({
    id: execution.id,
    userId: execution.user_id,
    workflowId: execution.workflow_id,
    status: execution.status,
    triggerType: execution.trigger_type,
    createdAt: execution.created_at,
    completedAt: execution.completed_at,
    failureCategory: execution.failure_category,
  }));
  const connections: MyDayConnectionCandidate[] = connectionResult.data.map((connection) => ({
    id: connection.id,
    userId: connection.user_id,
    provider: connection.provider_family,
    status: connection.status,
  }));

  return buildMyDayData({ userId, workflows, executions, connections });
}
