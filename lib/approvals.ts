import "server-only";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import {
  createApprovalWithStore,
  decideApprovalWithStore,
  type ApprovalRequest,
  type CreateApprovalInput,
} from "@/lib/approvals-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTrustedWorkspaceMembership } from "@/lib/workspace-context";

const APPROVAL_LIST_LIMIT = 50;

/** Trusted server producers only. There is deliberately no browser creation action. */
export async function createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalRequest> {
  const admin = createAdminClient();
  return createApprovalWithStore(input, {
    async resolveWorkspace(actorUserId) {
      return (await resolveTrustedWorkspaceMembership(actorUserId)).workspaceId;
    },
    async isApproverMember(workspaceId, approverUserId) {
      const { data, error } = await admin.from("workspace_memberships").select("user_id")
        .eq("workspace_id", workspaceId).eq("user_id", approverUserId)
        .eq("is_default", true).maybeSingle();
      if (error) throw new Error("Approval membership could not be verified.");
      return Boolean(data);
    },
    async findWorkItem(id, workspaceId) {
      const { data, error } = await admin.from("work_items")
        .select("assignee_user_id,source_type,source_id,status")
        .eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
      if (error) throw new Error("Approval work item could not be verified.");
      return data;
    },
    async insertAtomically(value, workspaceId, snapshot) {
      const { data, error } = await admin.rpc("create_approval_request", {
        p_actor_user_id: value.actorUserId,
        p_work_item_id: value.workItemId,
        p_approver_user_id: value.approverUserId,
        p_origin_type: value.originType,
        p_source_id: value.sourceId ?? null,
        p_request_key: value.requestKey,
        p_action_title: value.actionTitle,
        p_action_summary: value.actionSummary,
        p_approval_reason: value.approvalReason,
        p_capability_id: value.capabilityId,
        p_action_snapshot: snapshot,
      });
      if (error || data?.length !== 1 || data[0].workspace_id !== workspaceId
        || data[0].approver_user_id !== value.approverUserId || data[0].work_item_id !== value.workItemId) return null;
      return data[0];
    },
  });
}

/** Browser reads use RLS and explicit default-workspace/approver filtering. */
export async function listCurrentUserPendingApprovals(): Promise<ApprovalRequest[]> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { data, error } = await auth.supabase.from("approval_requests").select("*")
    .eq("workspace_id", auth.workspace.id)
    .eq("approver_user_id", auth.user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(APPROVAL_LIST_LIMIT);
  if (error) throw new Error("Approvals could not be loaded.");
  return data ?? [];
}

export async function getCurrentUserApproval(id: string): Promise<ApprovalRequest | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const parsedId = z.uuid().parse(id);
  const { data, error } = await auth.supabase.from("approval_requests").select("*")
    .eq("id", parsedId).eq("workspace_id", auth.workspace.id)
    .eq("approver_user_id", auth.user.id).maybeSingle();
  if (error) throw new Error("Approval could not be loaded.");
  return data;
}

async function decideApproval(input: {
  id: string;
  actorUserId: string;
  workspaceId: string;
  decision: "approved" | "rejected" | "cancelled";
  rejectionReason?: string | null;
}): Promise<ApprovalRequest> {
  const admin = createAdminClient();
  return decideApprovalWithStore(input, {
    async findInWorkspace(id, workspaceId) {
      const { data, error } = await admin.from("approval_requests").select("*")
        .eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
      if (error) throw new Error("Approval could not be loaded.");
      return data;
    },
    async commitAtomically(value) {
      // Revalidate every ownership/state invariant under row locks in the RPC.
      const { data, error } = await admin.rpc("decide_approval_request", {
        p_approval_id: value.id,
        p_actor_user_id: value.actorUserId,
        p_decision: value.decision,
        p_rejection_reason: value.rejectionReason,
      });
      if (error || data?.length !== 1) return null;
      return data[0];
    },
  });
}

/** Authenticated employee may decide only their own pending approval. */
export async function decideCurrentUserApproval(input: { id: string; decision: "approved" | "rejected"; rejectionReason?: string | null }): Promise<ApprovalRequest> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  return decideApproval({ ...input, actorUserId: auth.user.id, workspaceId: auth.workspace.id });
}

/** Trusted server path only; request owner can cancel, browser receives no cancel action. */
export async function cancelApprovalRequest(input: { id: string; actorUserId: string }): Promise<ApprovalRequest> {
  const membership = await resolveTrustedWorkspaceMembership(z.uuid().parse(input.actorUserId));
  return decideApproval({ id: input.id, actorUserId: input.actorUserId, workspaceId: membership.workspaceId, decision: "cancelled" });
}
