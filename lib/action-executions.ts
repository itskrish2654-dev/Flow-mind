import "server-only";

import { z } from "zod";

import {
  ActionPreviewSchema,
  actionApprovalDisposition,
  actionOutcomeSummary,
  approvalSnapshotFromPreview,
  type ActionPreview,
} from "@/lib/action-execution-core";
import { AskResponseMetadataSchema } from "@/lib/ask-core";
import { getAuthenticatedContext } from "@/lib/auth";
import { getCapability } from "@/lib/capability-registry";
import { googleSheetsAcceptanceCapability } from "@/lib/google-sheets-live-acceptance";
import { notionAcceptanceAction } from "@/lib/notion-live-acceptance";
import { getConnectorOperation } from "@/lib/connectors/registry";
import { connectorConnectionIds } from "@/lib/connectors/connection-matching";
import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

export type ActionExecution = Database["public"]["Tables"]["action_executions"]["Row"];
export type ActionExecutionView = Omit<ActionExecution, "claim_token" | "idempotency_key">;

const ACTION_EXECUTION_VIEW_COLUMNS = [
  "id", "workspace_id", "requester_user_id", "approval_request_id", "work_item_id",
  "source_message_id", "connection_id", "capability_id", "connector_id", "operation_key",
  "operation_version", "status", "claimed_at", "attempt_count", "acknowledged",
  "externally_delivered", "provider_reference_id", "result_summary", "failure_category",
  "failure_message", "created_at", "updated_at", "completed_at",
].join(",");

function acceptanceHarnessEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.WORK_OS_ACTION_ACCEPTANCE_ENABLED !== "true") return false;
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "").hostname === "localhost";
  } catch {
    return false;
  }
}

function isExecutableCapability(preview: ActionPreview) {
  const capability = getCapability(preview.capabilityId);
  const operation = capability?.connectorOperation;
  if (!capability || (!capability.supported && !notionAcceptanceAction(preview.capabilityId))
    || !operation || operation.operationKind !== "action") return false;
  if (operation.connectorId !== preview.connectorId || operation.operationKey !== preview.operationKey
    || operation.operationVersion !== preview.operationVersion) return false;
  if (capability.internalOnly) return preview.capabilityId === "internal.action_acknowledge"
    && capability.availableInTest && acceptanceHarnessEnabled();
  return capability.availableInProduction || googleSheetsAcceptanceCapability(capability.id) || notionAcceptanceAction(capability.id);
}

async function assertUsableConnection(execution: ActionExecution) {
  if (!execution.connection_id) throw new Error("The approved connection is unavailable.");
  const capability = getCapability(execution.capability_id);
  if (!capability || !isExecutableCapability({
    version: 1,
    capabilityId: execution.capability_id,
    connectorId: execution.connector_id,
    operationKey: execution.operation_key,
    operationVersion: execution.operation_version,
    connectionId: execution.connection_id,
    actionTitle: "Revalidation",
    actionSummary: "Revalidate the exact approved action.",
    approvalReason: "Execution-time capability validation.",
    target: { kind: "internal_record", label: "Action", reference: execution.id },
    parameters: [],
  })) throw new Error("This action capability is no longer available.");
  const admin = createAdminClient();
  const registered = getConnectorOperation(execution.connector_id, "action", execution.operation_key, execution.operation_version);
  if (!registered) throw new Error("The approved connector action is unavailable.");
  const { data, error } = await admin.from("connector_connections")
    .select("id,user_id,workspace_id,connector_id,status,granted_scopes")
    .eq("id", execution.connection_id)
    .eq("user_id", execution.requester_user_id)
    .eq("workspace_id", execution.workspace_id)
    .eq("provider_family", registered.connector.manifest.providerFamily)
    .in("connector_id", connectorConnectionIds(registered.connector.manifest))
    .eq("status", "connected")
    .maybeSingle();
  if (error || !data || capability.requiredScopes.some((scope) => !data.granted_scopes.includes(scope))) {
    throw new Error("The approved connection is no longer usable.");
  }
}

function executionInput(preview: ActionPreview) {
  const registered = getConnectorOperation(preview.connectorId, "action", preview.operationKey, preview.operationVersion);
  if (!registered?.handler || !registered.operation.production
    && !acceptanceHarnessEnabled()
    && !googleSheetsAcceptanceCapability(preview.capabilityId)) {
    throw new Error("The approved connector action is unavailable.");
  }
  const allowed = new Map(registered.operation.input.map((field) => [field.key, field]));
  const input: Record<string, unknown> = {};
  for (const parameter of preview.parameters) {
    const field = allowed.get(parameter.name);
    if (!field) throw new Error("The approved action contains an unsupported parameter.");
    if (field.type === "object" || field.type === "array") {
      try { input[field.key] = JSON.parse(parameter.value); } catch { throw new Error("The approved action contains invalid structured data."); }
    } else if (field.type === "number") input[field.key] = Number(parameter.value);
    else if (field.type === "boolean") input[field.key] = parameter.value === "true";
    else input[field.key] = parameter.value;
  }
  for (const field of registered.operation.input) {
    if (field.required && !(field.key in input)) throw new Error(`The approved action is missing ${field.label}.`);
  }
  return { registered, input };
}

export async function createActionApprovalFromAskMessage(messageId: string): Promise<ActionExecution> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const id = z.uuid().parse(messageId);
  const { data: message, error } = await auth.supabase.from("ask_messages")
    .select("id,role,response_metadata")
    .eq("id", id).eq("workspace_id", auth.workspace.id).eq("user_id", auth.user.id)
    .eq("role", "assistant").maybeSingle();
  if (error || !message) throw new Error("Action preview is unavailable.");
  const metadata = AskResponseMetadataSchema.safeParse(message.response_metadata);
  const parsedMetadata = metadata.success ? metadata.data : null;
  const preview = parsedMetadata?.actionPreview;
  if (!preview || parsedMetadata.responseType !== "action_preview" || !isExecutableCapability(preview)) {
    throw new Error("Action preview is unavailable.");
  }
  const admin = createAdminClient();
  const { data, error: rpcError } = await admin.rpc("create_action_approval", {
    p_actor_user_id: auth.user.id,
    p_source_message_id: message.id,
    p_request_key: `ask-action:${message.id}`,
    p_action_title: preview.actionTitle,
    p_action_summary: preview.actionSummary,
    p_approval_reason: preview.approvalReason,
    p_capability_id: preview.capabilityId,
    p_connector_id: preview.connectorId,
    p_operation_key: preview.operationKey,
    p_operation_version: preview.operationVersion,
    p_connection_id: preview.connectionId,
    p_action_snapshot: approvalSnapshotFromPreview(preview) as Json,
  });
  if (rpcError || data?.length !== 1) throw new Error("Action approval could not be created.");
  return data[0];
}

async function loadPreview(execution: ActionExecution): Promise<ActionPreview> {
  const admin = createAdminClient();
  const { data: approval, error } = await admin.from("approval_requests")
    .select("action_title,action_summary,approval_reason,action_snapshot")
    .eq("id", execution.approval_request_id).eq("workspace_id", execution.workspace_id).single();
  if (error || !approval || !execution.connection_id) throw new Error("Approved action snapshot is unavailable.");
  const stored = z.object({
    version: z.literal(1), operationKey: z.string(),
    target: z.object({ kind: z.enum(["internal_record", "external_resource", "workflow_step"]), label: z.string(), reference: z.string() }),
    parameters: z.array(z.object({ name: z.string(), label: z.string(), value: z.string() })),
  }).strict().parse(approval.action_snapshot);
  return ActionPreviewSchema.parse({
    version: 1,
    capabilityId: execution.capability_id,
    connectorId: execution.connector_id,
    operationKey: execution.operation_key,
    operationVersion: execution.operation_version,
    connectionId: execution.connection_id,
    actionTitle: approval.action_title,
    actionSummary: approval.action_summary,
    approvalReason: approval.approval_reason,
    target: stored.target,
    parameters: stored.parameters,
  });
}

async function complete(execution: ActionExecution, claimToken: string, input: {
  status: "succeeded" | "failed" | "ambiguous";
  acknowledged: boolean;
  externallyDelivered: boolean;
  providerReferenceId?: string;
  resultSummary: string;
  failureCategory?: string;
  failureMessage?: string;
}) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("complete_action_execution", {
    p_execution_id: execution.id,
    p_claim_token: claimToken,
    p_status: input.status,
    p_acknowledged: input.acknowledged,
    p_externally_delivered: input.externallyDelivered,
    p_provider_reference_id: input.providerReferenceId ?? null,
    p_result_summary: input.resultSummary,
    p_failure_category: input.failureCategory ?? null,
    p_failure_message: input.failureMessage ?? null,
  });
  if (error || data?.length !== 1) throw new Error("Action result could not be persisted.");
  return data[0] as ActionExecution;
}

async function executeQueuedAction(execution: ActionExecution): Promise<ActionExecution> {
  const admin = createAdminClient();
  const { data: claimed, error } = await admin.rpc("claim_action_execution", {
    p_execution_id: execution.id,
    p_actor_user_id: execution.requester_user_id,
  });
  if (error) throw new Error("Approved action could not be claimed.");
  if (claimed?.length !== 1) {
    const { data } = await admin.from("action_executions").select("*").eq("id", execution.id).single();
    if (!data) throw new Error("Approved action is unavailable.");
    return data;
  }
  const action = claimed[0] as ActionExecution;
  const claimToken = action.claim_token;
  if (!claimToken) throw new Error("Action claim is invalid.");
  try {
    await assertUsableConnection(action);
    const preview = await loadPreview(action);
    const { registered, input } = executionInput(preview);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("ACTION_TIMEOUT")); }, 20_000);
    });
    try {
      const result = await Promise.race([
        (registered.handler as ConnectorActionHandler)(input, {
          userId: action.requester_user_id,
          workflowId: action.work_item_id,
          executionId: action.id,
          stepId: action.approval_request_id,
          connectionId: action.connection_id ?? undefined,
          idempotencyKey: action.idempotency_key,
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (result.status === "succeeded" && result.acknowledged && result.externallyDelivered) {
        const sheets = action.capability_id === "google_sheets_add_row" || action.capability_id === "google_sheets_update_row";
        const calendar = action.capability_id === "google_calendar_create_event" || action.capability_id === "google_calendar_update_event";
        const notion = action.capability_id === "notion_create_data_source_item" || action.capability_id === "notion_update_item";
        return complete(action, claimToken, {
          status: "succeeded", acknowledged: true, externallyDelivered: true,
          providerReferenceId: result.providerReferenceId,
          resultSummary: sheets && result.providerReferenceId
            ? `Google Sheets acknowledged the exact approved change at ${result.providerReferenceId.slice(0, 180)}.`
            : calendar && result.providerReferenceId
              ? `Google Calendar acknowledged the exact approved event change (event ${result.providerReferenceId.slice(0, 100)}).`
            : notion && result.providerReferenceId
              ? `Notion acknowledged the exact approved item change (item ${result.providerReferenceId.slice(0, 100)}).`
            : "The provider acknowledged the exact approved action.",
        });
      }
      const ambiguous = result.status === "ambiguous" || result.error?.category === "ambiguous_acknowledgement";
      return complete(action, claimToken, {
        status: ambiguous ? "ambiguous" : "failed",
        acknowledged: result.acknowledged,
        externallyDelivered: false,
        resultSummary: actionOutcomeSummary(ambiguous ? "ambiguous" : "failed"),
        failureCategory: ambiguous ? "ambiguous_external_result" : result.error?.category ?? "provider_rejection",
        failureMessage: result.error?.message ?? "The provider did not acknowledge the approved action.",
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    const timeout = error instanceof Error && error.message === "ACTION_TIMEOUT";
    return complete(action, claimToken, {
      status: timeout ? "ambiguous" : "failed",
      acknowledged: false,
      externallyDelivered: false,
      resultSummary: actionOutcomeSummary(timeout ? "ambiguous" : "failed"),
      failureCategory: timeout ? "ambiguous_external_result" : "internal_execution_failure",
      failureMessage: timeout
        ? "The provider outcome could not be confirmed. Do not retry without review."
        : "The approved action could not be executed.",
    });
  }
}

export async function decideAndExecuteCurrentUserAction(input: {
  approvalId: string;
  decision: "approved" | "rejected";
  rejectionReason?: string | null;
}): Promise<ActionExecution | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const approvalId = z.uuid().parse(input.approvalId);
  const admin = createAdminClient();
  const { data: existing, error: findError } = await admin.from("action_executions").select("*")
    .eq("approval_request_id", approvalId).eq("workspace_id", auth.workspace.id)
    .eq("requester_user_id", auth.user.id).maybeSingle();
  if (findError) throw new Error("Action approval is unavailable.");
  if (!existing) return null;

  let action = existing;
  const disposition = actionApprovalDisposition(action.status, input.decision);
  if (disposition === "already_decided") throw new Error("Action approval was already decided.");
  if (disposition === "decide") {
    const { data, error } = await admin.rpc("decide_action_execution", {
      p_approval_id: approvalId,
      p_actor_user_id: auth.user.id,
      p_decision: input.decision,
      p_rejection_reason: input.decision === "rejected" ? input.rejectionReason ?? null : null,
    });
    if (error || data?.length !== 1) throw new Error("Action approval could not be decided.");
    action = data[0];
  }
  if (input.decision === "approved" && action.status === "queued") return executeQueuedAction(action);
  return action;
}

export async function listCurrentUserActionExecutions(limit = 30): Promise<ActionExecutionView[]> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { data, error } = await auth.supabase.from("action_executions").select(ACTION_EXECUTION_VIEW_COLUMNS)
    .eq("workspace_id", auth.workspace.id).eq("requester_user_id", auth.user.id)
    .order("created_at", { ascending: false }).limit(Math.min(50, Math.max(1, limit)));
  if (error) throw new Error("Action activity is unavailable.");
  return data as unknown as ActionExecutionView[];
}

export async function getCurrentUserActionExecution(id: string): Promise<ActionExecutionView | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { data, error } = await auth.supabase.from("action_executions").select(ACTION_EXECUTION_VIEW_COLUMNS)
    .eq("id", z.uuid().parse(id)).eq("workspace_id", auth.workspace.id)
    .eq("requester_user_id", auth.user.id).maybeSingle();
  if (error) throw new Error("Action activity is unavailable.");
  return data as unknown as ActionExecutionView | null;
}
