import "server-only";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTrustedWorkspaceMembership } from "@/lib/workspace-context";
import {
  createWorkItemWithStore,
  transitionOwnedWorkItemWithStore,
  type CreateWorkItemInput,
  type WorkItem,
  type WorkItemCreateStore,
  type WorkItemSourceType,
  type WorkItemStatus,
  type WorkItemTransitionStore,
  type EmployeeWorkStatus,
} from "@/lib/work-items-core";

const WORK_ITEM_LIST_LIMIT = 50;

/** For trusted server producers only. This module is never a browser action. */
export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
  const admin = createAdminClient();
  const store: WorkItemCreateStore = {
    async resolveWorkspace(actorUserId) {
      return (await resolveTrustedWorkspaceMembership(actorUserId)).workspaceId;
    },
    async isMember(workspaceId, assigneeUserId) {
      const { data, error } = await admin.from("workspace_memberships")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .eq("user_id", assigneeUserId)
        .eq("is_default", true)
        .maybeSingle();
      if (error) throw new Error("Work item membership could not be verified.");
      return Boolean(data);
    },
    async insert(row) {
      const { data, error } = await admin.from("work_items").insert(row).select("*").single();
      if (error?.code === "23505" && row.dedupe_key) return { item: null, duplicate: true };
      if (error || !data) throw new Error("Work item could not be created.");
      return { item: data, duplicate: false };
    },
    async findByDedupe(workspaceId: string, sourceType: WorkItemSourceType, sourceId: string | null, key: string) {
      let query = admin.from("work_items").select("*")
        .eq("workspace_id", workspaceId).eq("source_type", sourceType).eq("dedupe_key", key);
      query = sourceId === null ? query.is("source_id", null) : query.eq("source_id", sourceId);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error("Work item dedupe state could not be verified.");
      return data;
    },
  };
  return createWorkItemWithStore(input, store);
}

/** Browser reads use their own authenticated client, explicit scope, and RLS. */
export async function listCurrentUserWorkItems(options: { includeDone?: boolean } = {}): Promise<WorkItem[]> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const statuses: WorkItem["status"][] = ["needs_you", "in_progress", "waiting", "blocked", "handled"];
  if (options.includeDone) statuses.push("done");
  const results = await Promise.all(statuses.map((status) => auth.supabase.from("work_items").select("*")
    .eq("workspace_id", auth.workspace.id).eq("assignee_user_id", auth.user.id)
    .eq("status", status).order("updated_at", { ascending: false })
    .limit(status === "done" ? 10 : WORK_ITEM_LIST_LIMIT)));
  if (results.some((result) => result.error)) throw new Error("Work items could not be loaded.");
  return results.flatMap((result) => result.data ?? []);
}

export async function getCurrentUserWorkItem(id: string): Promise<WorkItem | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const parsedId = z.uuid().parse(id);
  const { data, error } = await auth.supabase.from("work_items").select("*")
    .eq("id", parsedId)
    .eq("workspace_id", auth.workspace.id)
    .eq("assignee_user_id", auth.user.id)
    .maybeSingle();
  if (error) throw new Error("Work item could not be loaded.");
  return data;
}

/** Authenticated employee action: only status changes, never identity or provenance. */
export async function transitionCurrentUserWorkItem(id: string, to: EmployeeWorkStatus,
  reason?: string | null): Promise<WorkItem> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const admin = createAdminClient();
  const store: WorkItemTransitionStore = {
    async findOwned(itemId, workspaceId, assigneeUserId) {
      const { data, error } = await admin.from("work_items").select("*")
        .eq("id", itemId).eq("workspace_id", workspaceId).eq("assignee_user_id", assigneeUserId).maybeSingle();
      if (error) throw new Error("Work item could not be loaded.");
      return data;
    },
    async updateStatus(itemId, workspaceId, assigneeUserId, from: WorkItemStatus, next: WorkItemStatus,
      statusReason?: string | null) {
      const { data, error } = await admin.from("work_items")
        .update({
          status: next,
          status_reason: statusReason ?? null,
          status_actor_user_id: auth.user.id,
          updated_at: new Date().toISOString(),
          resolved_at: next === "done" ? new Date().toISOString() : null,
        })
        .eq("id", itemId).eq("workspace_id", workspaceId).eq("assignee_user_id", assigneeUserId)
        .eq("status", from).select("*").maybeSingle();
      if (error) throw new Error("Work item could not be updated.");
      return data;
    },
  };
  return transitionOwnedWorkItemWithStore({
    id, workspaceId: auth.workspace.id, assigneeUserId: auth.user.id, to, reason,
  }, store);
}

/** Only a persisted successful execution for this exact item may claim system handling. */
export async function markWorkItemHandledForExecution(input: {
  itemId: string;
  executionId: string;
}): Promise<WorkItem> {
  const itemId = z.uuid().parse(input.itemId);
  const executionId = z.uuid().parse(input.executionId);
  const admin = createAdminClient();
  const { data: execution, error: executionError } = await admin.from("workflow_executions")
    .select("id,user_id,workflow_id,status")
    .eq("id", executionId).eq("status", "succeeded").maybeSingle();
  if (executionError || !execution) throw new Error("Successful execution proof is unavailable.");
  const workspaceId = (await resolveTrustedWorkspaceMembership(execution.user_id)).workspaceId;
  const { data: item, error: itemError } = await admin.from("work_items").select("*")
    .eq("id", itemId).eq("workspace_id", workspaceId).eq("assignee_user_id", execution.user_id).maybeSingle();
  if (itemError || !item || item.source_type !== "workflow_execution" || item.source_id !== executionId) {
    throw new Error("Work item cannot be marked handled without matching execution provenance.");
  }
  if (!["needs_you", "in_progress", "waiting", "blocked"].includes(item.status)) {
    throw new Error("Work item is already resolved.");
  }
  const { data: workflow, error: workflowError } = await admin.from("workflows").select("id")
    .eq("id", execution.workflow_id).eq("user_id", execution.user_id)
    .eq("workspace_id", workspaceId).maybeSingle();
  if (workflowError || !workflow) throw new Error("Execution workspace proof is unavailable.");
  const now = new Date().toISOString();
  const { data: handled, error: updateError } = await admin.from("work_items")
    .update({ status: "handled", status_reason: null, status_actor_user_id: execution.user_id,
      resolved_at: now, updated_at: now })
    .eq("id", itemId).eq("workspace_id", workspaceId).eq("assignee_user_id", execution.user_id)
    .eq("source_type", "workflow_execution").eq("source_id", executionId)
    .eq("status", item.status).select("*").maybeSingle();
  if (updateError || !handled) throw new Error("Work item could not be marked handled.");
  return handled;
}
