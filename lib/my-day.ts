import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildMyDayData,
  indexCredentialMetadata,
  MY_DAY_LIMITS,
  relevantUnboundConnectionProvidersFromWorkflows,
  selectedConnectionIdsFromWorkflows,
  type MyDayConnectionCandidate,
  type MyDayCredentialMetadataCandidate,
  type MyDayData,
  type MyDayExecutionCandidate,
  type MyDayWorkflowCandidate,
} from "@/lib/my-day-model";

async function loadRelevantCredentialMetadata({
  userId,
  workflowIds,
}: {
  userId: string;
  workflowIds: readonly string[];
}): Promise<{ credentials: MyDayCredentialMetadataCandidate[]; complete: boolean }> {
  if (workflowIds.length === 0) return { credentials: [], complete: true };

  const admin = createAdminClient();
  const credentials: MyDayCredentialMetadataCandidate[] = [];
  for (let page = 0; page < MY_DAY_LIMITS.credentialPages; page += 1) {
    const from = page * MY_DAY_LIMITS.credentials;
    const to = from + MY_DAY_LIMITS.credentials - 1;
    const { data, error } = await admin
      .from("workflow_credentials")
      .select("user_id, workflow_id, connector_id, credential_key")
      .eq("user_id", userId)
      .in("workflow_id", workflowIds)
      .order("workflow_id", { ascending: true })
      .order("connector_id", { ascending: true })
      .order("credential_key", { ascending: true })
      .range(from, to);
    if (error) throw new Error("My Day could not load credential status safely.");
    credentials.push(...data.map((credential) => ({
      userId: credential.user_id,
      workflowId: credential.workflow_id,
      connectorId: credential.connector_id,
      credentialKey: credential.credential_key,
    })));
    if (data.length < MY_DAY_LIMITS.credentials) {
      return { credentials, complete: true };
    }
  }

  const overflowOffset = MY_DAY_LIMITS.credentials * MY_DAY_LIMITS.credentialPages;
  const { data: overflow, error: overflowError } = await admin
    .from("workflow_credentials")
    .select("id")
    .eq("user_id", userId)
    .in("workflow_id", workflowIds)
    .order("workflow_id", { ascending: true })
    .order("connector_id", { ascending: true })
    .order("credential_key", { ascending: true })
    .range(overflowOffset, overflowOffset);
  if (overflowError) throw new Error("My Day could not confirm credential status safely.");
  return { credentials, complete: overflow.length === 0 };
}

export async function loadMyDayData(): Promise<MyDayData | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;

  const userId = auth.user.id;
  const workspaceId = auth.workspace.id;
  const [workflowResult, executionResult] = await Promise.all([
    auth.supabase
      .from("workflows")
      .select("id, user_id, name, lifecycle_state, current_version_id, updated_at")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .neq("lifecycle_state", "archived")
      .order("updated_at", { ascending: false })
      .limit(MY_DAY_LIMITS.workflows),
    auth.supabase
      .from("workflow_executions")
      .select("id, user_id, workflow_id, status, trigger_type, created_at, completed_at, failure_category")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(MY_DAY_LIMITS.executions),
  ]);

  if (workflowResult.error || executionResult.error) {
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
  const workflowSnapshots = workflowResult.data.flatMap((workflow) => {
    const version = workflow.current_version_id ? versionById.get(workflow.current_version_id) : null;
    if (!version || version.workflow_id !== workflow.id || version.user_id !== userId) return [];
    return [{ workflow, version }];
  });
  const relevantWorkflowIds = workflowSnapshots.map(({ workflow }) => workflow.id);
  const selectedConnectionIds = selectedConnectionIdsFromWorkflows(
    workflowSnapshots.map(({ version }) => version.compiled_workflow),
  );
  const relevantUnboundProviders = relevantUnboundConnectionProvidersFromWorkflows(
    workflowSnapshots.map(({ version }) => version.compiled_workflow),
  );
  if (selectedConnectionIds.length > MY_DAY_LIMITS.selectedConnections) {
    throw new Error("My Day could not safely resolve selected connections.");
  }

  const selectedConnectionRequest = selectedConnectionIds.length > 0
    ? auth.supabase
        .from("connector_connections")
        .select("id, user_id, provider_family, status")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .in("id", selectedConnectionIds)
        .limit(MY_DAY_LIMITS.selectedConnections)
    : Promise.resolve({ data: [], error: null });
  const providerConnectionRequest = Promise.all(
    relevantUnboundProviders.map((provider) => auth.supabase
      .from("connector_connections")
      .select("id, user_id, provider_family, status")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .eq("provider_family", provider)
      .eq("status", "connected")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1)),
  );
  const [selectedConnectionResult, providerConnectionResults, credentialResult] = await Promise.all([
    selectedConnectionRequest,
    providerConnectionRequest,
    loadRelevantCredentialMetadata({ userId, workflowIds: relevantWorkflowIds }),
  ]);
  if (selectedConnectionResult.error || providerConnectionResults.some((result) => result.error)) {
    throw new Error("My Day could not load connection status safely.");
  }

  const credentialKeysByWorkflow = indexCredentialMetadata({
    userId,
    workflowIds: new Set(relevantWorkflowIds),
    credentials: credentialResult.credentials,
  });

  const workflows: MyDayWorkflowCandidate[] = workflowSnapshots.map(({ workflow, version }) => ({
      id: workflow.id,
      userId: workflow.user_id,
      name: workflow.name,
      lifecycleState: workflow.lifecycle_state,
      updatedAt: workflow.updated_at,
      workflow: version.compiled_workflow,
      setupConfig: version.setup_config,
      configuredCredentialKeys: credentialKeysByWorkflow.get(workflow.id) ?? [],
      credentialMetadataComplete: credentialResult.complete,
  }));
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
  const providerConnectionRows = providerConnectionResults.flatMap((result) => result.data ?? []);
  const connectionRows = new Map(
    [...providerConnectionRows, ...selectedConnectionResult.data]
      .map((connection) => [connection.id, connection] as const),
  );
  const connections: MyDayConnectionCandidate[] = [...connectionRows.values()].map((connection) => ({
    id: connection.id,
    userId: connection.user_id,
    provider: connection.provider_family,
    status: connection.status,
  }));

  return buildMyDayData({ userId, workflows, executions, connections });
}
