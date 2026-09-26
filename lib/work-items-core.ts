import { z } from "zod";

import type { Database } from "@/lib/supabase/types";

export type WorkItem = Database["public"]["Tables"]["work_items"]["Row"];
export type WorkItemStatus = WorkItem["status"];
export type WorkItemPriority = WorkItem["priority"];
export type WorkItemSourceType = WorkItem["source_type"];

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish();

export const CreateWorkItemSchema = z.object({
  actorUserId: z.uuid(),
  assigneeUserId: z.uuid(),
  title: z.string().trim().min(1).max(180),
  summary: optionalText(2000),
  whyItMatters: optionalText(1000),
  suggestedAction: optionalText(500),
  status: z.enum(["needs_you", "waiting"]).default("needs_you"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  dueAt: z.iso.datetime({ offset: true }).nullish(),
  sourceType: z.enum(["workflow", "workflow_execution", "connector_event", "system", "internal"]),
  sourceId: optionalText(200),
  sourceLabel: optionalText(120),
  dedupeKey: optionalText(160),
}).strict().superRefine((value, context) => {
  if (["workflow", "workflow_execution", "connector_event"].includes(value.sourceType) && !value.sourceId) {
    context.addIssue({ code: "custom", path: ["sourceId"], message: "Source reference is required." });
  }
});

export type CreateWorkItemInput = z.input<typeof CreateWorkItemSchema>;
export type WorkItemInsert = Database["public"]["Tables"]["work_items"]["Insert"];

export interface WorkItemCreateStore {
  resolveWorkspace(actorUserId: string): Promise<string>;
  isMember(workspaceId: string, assigneeUserId: string): Promise<boolean>;
  insert(row: WorkItemInsert): Promise<{ item: WorkItem | null; duplicate: boolean }>;
  findByDedupe(workspaceId: string, sourceType: WorkItemSourceType, sourceId: string | null, key: string): Promise<WorkItem | null>;
}

/** The caller is trusted server code; no workspace ID or handled state is accepted. */
export async function createWorkItemWithStore(input: CreateWorkItemInput, store: WorkItemCreateStore): Promise<WorkItem> {
  const value = CreateWorkItemSchema.parse(input);
  const workspaceId = await store.resolveWorkspace(value.actorUserId);
  if (!await store.isMember(workspaceId, value.assigneeUserId)) {
    throw new Error("Work item assignee is not a member of the trusted workspace.");
  }
  const row: WorkItemInsert = {
    workspace_id: workspaceId,
    assignee_user_id: value.assigneeUserId,
    title: value.title,
    summary: value.summary ?? null,
    why_it_matters: value.whyItMatters ?? null,
    suggested_action: value.suggestedAction ?? null,
    status: value.status,
    priority: value.priority,
    due_at: value.dueAt ?? null,
    source_type: value.sourceType,
    source_id: value.sourceId ?? null,
    source_label: value.sourceLabel ?? null,
    dedupe_key: value.dedupeKey ?? null,
  };
  const result = await store.insert(row);
  if (result.item) return result.item;
  if (result.duplicate && value.dedupeKey) {
    const existing = await store.findByDedupe(workspaceId, value.sourceType, value.sourceId ?? null, value.dedupeKey);
    if (existing && existing.assignee_user_id === value.assigneeUserId) return existing;
    throw new Error("Work item dedupe identity is already assigned elsewhere.");
  }
  throw new Error("Work item could not be created.");
}

const employeeTransitions: Readonly<Record<"needs_you" | "waiting", readonly WorkItemStatus[]>> = {
  needs_you: ["waiting", "done"],
  waiting: ["needs_you", "done"],
};

export function isAllowedEmployeeTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return (from === "needs_you" || from === "waiting") && employeeTransitions[from].includes(to);
}

export interface WorkItemTransitionStore {
  findOwned(id: string, workspaceId: string, assigneeUserId: string): Promise<WorkItem | null>;
  updateStatus(id: string, workspaceId: string, assigneeUserId: string, from: WorkItemStatus, to: WorkItemStatus): Promise<WorkItem | null>;
}

export async function transitionOwnedWorkItemWithStore(input: {
  id: string;
  workspaceId: string;
  assigneeUserId: string;
  to: "needs_you" | "waiting" | "done";
}, store: WorkItemTransitionStore): Promise<WorkItem> {
  const id = z.uuid().parse(input.id);
  const current = await store.findOwned(id, input.workspaceId, input.assigneeUserId);
  if (!current) throw new Error("Work item is unavailable.");
  if (!isAllowedEmployeeTransition(current.status, input.to)) {
    throw new Error("This work item cannot be moved to that state.");
  }
  const updated = await store.updateStatus(id, input.workspaceId, input.assigneeUserId, current.status, input.to);
  if (!updated) throw new Error("Work item changed while you were updating it. Please refresh.");
  return updated;
}
