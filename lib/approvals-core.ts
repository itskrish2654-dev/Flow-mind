import { z } from "zod";

import type { Database, Json } from "@/lib/supabase/types";
import type { WorkItem } from "@/lib/work-items-core";

export type ApprovalRequest = Database["public"]["Tables"]["approval_requests"]["Row"];
export type ApprovalDecision = "approved" | "rejected" | "cancelled";

const sensitiveName = /(?:secret|password|passwd|token|credential|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const sensitiveValue = /(?:\bBearer\s+\S+|sb_secret_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export const ApprovalActionTargetSchema = z.object({
  kind: z.enum(["internal_record", "external_resource", "workflow_step"]),
  label: z.string().trim().min(1).max(180),
  // Stable resource reference only; no URL query, header, or credential blob.
  reference: z.string().trim().regex(/^[A-Za-z0-9._:/@-]{1,300}$/),
}).strict();

export const ApprovalActionParameterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(100),
  value: z.string().max(500),
}).strict();

export const ApprovalActionSnapshotSchema = z.object({
  version: z.literal(1),
  operationKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  target: ApprovalActionTargetSchema,
  parameters: z.array(ApprovalActionParameterSchema).max(12),
}).strict().superRefine((value, context) => {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > 8192) {
    context.addIssue({ code: "custom", message: "Approval proposal is too large." });
  }
  if (sensitiveValue.test(serialized)) {
    context.addIssue({ code: "custom", message: "Approval proposal cannot contain credential material." });
  }
  for (const parameter of value.parameters) {
    if (sensitiveName.test(parameter.name) || sensitiveName.test(parameter.label) || sensitiveValue.test(parameter.value)) {
      context.addIssue({ code: "custom", message: "Approval proposal cannot contain credential material." });
      break;
    }
  }
});

export const CreateApprovalSchema = z.object({
  actorUserId: z.uuid(),
  workItemId: z.uuid(),
  approverUserId: z.uuid(),
  originType: z.enum(["workflow", "workflow_execution", "connector_event", "system", "internal"]),
  sourceId: z.string().trim().min(1).max(200).nullish(),
  requestKey: z.string().trim().min(1).max(160),
  actionTitle: z.string().trim().min(1).max(180),
  actionSummary: z.string().trim().min(1).max(2000),
  approvalReason: z.string().trim().min(1).max(1000),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  actionSnapshot: ApprovalActionSnapshotSchema,
}).strict().superRefine((value, context) => {
  if (value.capabilityId !== value.actionSnapshot.operationKey) {
    context.addIssue({ code: "custom", message: "Approval capability does not match the proposed action." });
  }
  if (["workflow", "workflow_execution", "connector_event"].includes(value.originType) && !value.sourceId) {
    context.addIssue({ code: "custom", message: "Source reference is required." });
  }
});

export type CreateApprovalInput = z.input<typeof CreateApprovalSchema>;

export const DecideApprovalSchema = z.object({
  id: z.uuid(),
  decision: z.enum(["approved", "rejected", "cancelled"]),
  rejectionReason: z.string().trim().min(1).max(500).nullish(),
}).strict().superRefine((value, context) => {
  if (value.decision !== "rejected" && value.rejectionReason) {
    context.addIssue({ code: "custom", message: "Only a rejection may have a reason." });
  }
});

export type DecideApprovalInput = z.input<typeof DecideApprovalSchema>;

export function approvalSnapshotForStorage(value: unknown): Json {
  // Parse, then serialize only the strict allowlisted fields. No caller object
  // reference can be mutated after request construction.
  return JSON.parse(JSON.stringify(ApprovalActionSnapshotSchema.parse(value))) as Json;
}

export interface ApprovalCreateStore {
  resolveWorkspace(actorUserId: string): Promise<string>;
  isApproverMember(workspaceId: string, approverUserId: string): Promise<boolean>;
  findWorkItem(id: string, workspaceId: string): Promise<Pick<WorkItem, "assignee_user_id" | "source_type" | "source_id" | "status"> | null>;
  /** Rechecks every invariant and idempotency identity inside one database transaction. */
  insertAtomically(value: z.output<typeof CreateApprovalSchema>, workspaceId: string, snapshot: Json): Promise<ApprovalRequest | null>;
}

export async function createApprovalWithStore(input: CreateApprovalInput, store: ApprovalCreateStore): Promise<ApprovalRequest> {
  const value = CreateApprovalSchema.parse(input);
  const workspaceId = await store.resolveWorkspace(value.actorUserId);
  if (!await store.isApproverMember(workspaceId, value.approverUserId)) {
    throw new Error("Approval owner is not a member of the trusted workspace.");
  }
  const item = await store.findWorkItem(value.workItemId, workspaceId);
  if (!item || item.assignee_user_id !== value.approverUserId
    || item.source_type !== value.originType || item.source_id !== (value.sourceId ?? null)) {
    throw new Error("Approval work item does not match the trusted proposal.");
  }
  // A terminal retry is allowed; the database checks that the same request key
  // still names the identical immutable proposal before checking item status.
  const result = await store.insertAtomically(value, workspaceId, approvalSnapshotForStorage(value.actionSnapshot));
  if (!result) throw new Error("Approval request could not be created.");
  return result;
}

export function isApprovalDecisionOwner(approval: ApprovalRequest, actorUserId: string, workspaceId: string, decision: ApprovalDecision): boolean {
  return approval.status === "pending"
    && approval.workspace_id === workspaceId
    && (decision === "cancelled"
      ? approval.requested_by_user_id === actorUserId
      : approval.approver_user_id === actorUserId);
}

export interface ApprovalDecisionStore {
  findInWorkspace(id: string, workspaceId: string): Promise<ApprovalRequest | null>;
  /** Must recheck owner/state and resolve Work Item in one database transaction. */
  commitAtomically(input: { id: string; actorUserId: string; decision: ApprovalDecision; rejectionReason: string | null }): Promise<ApprovalRequest | null>;
}

export async function decideApprovalWithStore(input: {
  id: string;
  actorUserId: string;
  workspaceId: string;
  decision: ApprovalDecision;
  rejectionReason?: string | null;
}, store: ApprovalDecisionStore): Promise<ApprovalRequest> {
  const value = DecideApprovalSchema.parse({
    id: input.id, decision: input.decision, rejectionReason: input.rejectionReason,
  });
  const actorUserId = z.uuid().parse(input.actorUserId);
  const workspaceId = z.uuid().parse(input.workspaceId);
  const approval = await store.findInWorkspace(value.id, workspaceId);
  if (!approval || !isApprovalDecisionOwner(approval, actorUserId, workspaceId, value.decision)) {
    throw new Error("Approval is unavailable or already decided.");
  }
  const storedSnapshot = ApprovalActionSnapshotSchema.safeParse(approval.action_snapshot);
  if (value.decision === "approved" && (!storedSnapshot.success || storedSnapshot.data.operationKey !== approval.capability_id)) {
    throw new Error("Approval proposal could not be verified.");
  }
  const decided = await store.commitAtomically({
    id: value.id, actorUserId, decision: value.decision,
    rejectionReason: value.rejectionReason ?? null,
  });
  if (!decided) throw new Error("Approval could not be decided.");
  return decided;
}
