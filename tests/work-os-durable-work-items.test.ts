import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildMyDayData, type BuildMyDayInput } from "../lib/my-day-model";
import {
  CreateWorkItemSchema,
  createWorkItemWithStore,
  isAllowedEmployeeTransition,
  transitionOwnedWorkItemWithStore,
  type WorkItem,
  type WorkItemCreateStore,
  type WorkItemTransitionStore,
} from "../lib/work-items-core";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const workspaceA = "00000000-0000-4000-8000-000000000010";
const workspaceB = "00000000-0000-4000-8000-000000000020";
const itemId = "00000000-0000-4000-8000-000000000030";
const now = "2026-09-26T10:00:00.000Z";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: itemId, workspace_id: workspaceA, assignee_user_id: userA,
    title: "Review the draft", summary: "Check the prepared result.",
    why_it_matters: "A customer is waiting.", suggested_action: "Review and decide.",
    status: "needs_you", priority: "high", due_at: now,
    status_reason: null, status_actor_user_id: null,
    source_type: "internal", source_id: null, source_label: "Customer request",
    dedupe_key: null, created_at: now, updated_at: now, resolved_at: null,
    goal_id: null, goal_plan_item_id: null,
    ...overrides,
  };
}

function createStore() {
  const rows: WorkItem[] = [];
  const store: WorkItemCreateStore = {
    async resolveWorkspace(actorUserId) {
      return actorUserId === userA ? workspaceA : workspaceB;
    },
    async isMember(workspaceId, assigneeUserId) {
      return (workspaceId === workspaceA && assigneeUserId === userA)
        || (workspaceId === workspaceB && assigneeUserId === userB);
    },
    async insert(row) {
      const duplicate = row.dedupe_key && rows.some((existing) => existing.workspace_id === row.workspace_id
        && existing.source_type === row.source_type && existing.source_id === row.source_id
        && existing.dedupe_key === row.dedupe_key);
      if (duplicate) return { item: null, duplicate: true };
      const created = item({ ...row, id: `00000000-0000-4000-8000-${String(rows.length + 31).padStart(12, "0")}` });
      rows.push(created);
      return { item: created, duplicate: false };
    },
    async findByDedupe(workspaceId, sourceType, sourceId, key) {
      return rows.find((existing) => existing.workspace_id === workspaceId
        && existing.source_type === sourceType && existing.source_id === sourceId
        && existing.dedupe_key === key) ?? null;
    },
  };
  return { store, rows };
}

const createInput = {
  actorUserId: userA,
  assigneeUserId: userA,
  title: "Review the draft",
  sourceType: "internal" as const,
  dedupeKey: "request-1",
};

test("work item content, status, priority, and provenance are constrained", () => {
  assert.equal(CreateWorkItemSchema.safeParse(createInput).success, true);
  assert.equal(CreateWorkItemSchema.safeParse({ ...createInput, status: "handled" }).success, false);
  assert.equal(CreateWorkItemSchema.safeParse({ ...createInput, priority: "critical" }).success, false);
  assert.equal(CreateWorkItemSchema.safeParse({ ...createInput, title: "x".repeat(181) }).success, false);
  assert.equal(CreateWorkItemSchema.safeParse({ ...createInput, sourceType: "workflow_execution" }).success, false);
  assert.equal(CreateWorkItemSchema.safeParse({ ...createInput, workspaceId: workspaceB }).success, false);
});

test("trusted workspace is applied, cross-workspace assignee is rejected, and dedupe is stable", async () => {
  const { store, rows } = createStore();
  const first = await createWorkItemWithStore(createInput, store);
  const retry = await createWorkItemWithStore(createInput, store);
  assert.equal(first.workspace_id, workspaceA);
  assert.equal(first.assignee_user_id, userA);
  assert.equal(retry.id, first.id);
  assert.equal(rows.length, 1);
  const another = await createWorkItemWithStore({ ...createInput, dedupeKey: "request-2" }, store);
  assert.notEqual(another.id, first.id);
  assert.equal(rows.length, 2);
  const firstWorkflow = await createWorkItemWithStore({ ...createInput, sourceType: "workflow", sourceId: "workflow-a" }, store);
  const secondWorkflow = await createWorkItemWithStore({ ...createInput, sourceType: "workflow", sourceId: "workflow-b" }, store);
  assert.notEqual(firstWorkflow.id, secondWorkflow.id);
  assert.equal(rows.length, 4);
  const otherWorkspace = await createWorkItemWithStore({ ...createInput, actorUserId: userB, assigneeUserId: userB }, store);
  assert.equal(otherWorkspace.workspace_id, workspaceB);
  assert.equal(rows.length, 5);
  await assert.rejects(() => createWorkItemWithStore({ ...createInput, assigneeUserId: userB }, store), /member/);
  assert.equal(rows.length, 5);
});

test("employee transitions are owner-scoped, conditional, and cannot spoof handled", async () => {
  let current = item();
  const store: WorkItemTransitionStore = {
    async findOwned(id, workspaceId, assigneeUserId) {
      return id === current.id && workspaceId === current.workspace_id && assigneeUserId === current.assignee_user_id ? current : null;
    },
    async updateStatus(id, workspaceId, assigneeUserId, from, to) {
      if (id !== current.id || workspaceId !== current.workspace_id || assigneeUserId !== current.assignee_user_id || current.status !== from) return null;
      current = item({ ...current, status: to });
      return current;
    },
  };
  await assert.rejects(() => transitionOwnedWorkItemWithStore({ id: itemId, workspaceId: workspaceB, assigneeUserId: userA, to: "done" }, store), /unavailable/);
  await assert.rejects(() => transitionOwnedWorkItemWithStore({ id: itemId, workspaceId: workspaceA, assigneeUserId: userB, to: "done" }, store), /unavailable/);
  assert.equal(isAllowedEmployeeTransition("needs_you", "handled"), false);
  assert.equal(isAllowedEmployeeTransition("done", "needs_you"), false);
  await transitionOwnedWorkItemWithStore({ id: itemId, workspaceId: workspaceA, assigneeUserId: userA, to: "waiting" }, store);
  await transitionOwnedWorkItemWithStore({ id: itemId, workspaceId: workspaceA, assigneeUserId: userA, to: "needs_you" }, store);
  await transitionOwnedWorkItemWithStore({ id: itemId, workspaceId: workspaceA, assigneeUserId: userA, to: "done" }, store);
  await assert.rejects(() => transitionOwnedWorkItemWithStore({ id: itemId, workspaceId: workspaceA, assigneeUserId: userA, to: "waiting" }, store), /cannot be moved/);
});

test("a concurrent status change is rejected instead of reporting false success", async () => {
  const store: WorkItemTransitionStore = {
    async findOwned() { return item(); },
    async updateStatus() { return null; },
  };
  await assert.rejects(() => transitionOwnedWorkItemWithStore({
    id: itemId, workspaceId: workspaceA, assigneeUserId: userA, to: "done",
  }, store), /changed while you were updating/);
});

test("My Day merges durable and workflow-derived items without showing done or other tenants", () => {
  const oldWorkflow = {
    id: "00000000-0000-4000-8000-000000000040", userId: userA, name: "Existing workflow",
    lifecycleState: "disabled" as const, updatedAt: now,
    workflow: { workflowName: "Existing workflow", summary: "Existing setup", steps: [{ id: "step-1", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store data" }] },
    setupConfig: {}, configuredCredentialKeys: [], credentialMetadataComplete: true,
  };
  const input: BuildMyDayInput = {
    userId: userA, workspaceId: workspaceA, workflows: [oldWorkflow], executions: [], connections: [],
    workItems: [
      item(), item({ id: "00000000-0000-4000-8000-000000000031", status: "waiting" }),
      item({ id: "00000000-0000-4000-8000-000000000032", status: "handled", resolved_at: now }),
      item({ id: "00000000-0000-4000-8000-000000000033", status: "done", resolved_at: now }),
      item({ id: "00000000-0000-4000-8000-000000000034", assignee_user_id: userB }),
      item({ id: "00000000-0000-4000-8000-000000000035", workspace_id: workspaceB }),
    ],
  };
  const result = buildMyDayData(input);
  assert.equal(result.summary.workflowCount, 1);
  assert.equal(result.needsYou.filter((entry) => entry.workItem).length, 1);
  assert.equal(result.waitingOn.filter((entry) => entry.workItem).length, 1);
  assert.equal(result.handledByCrazyLoops.length, 1);
  assert.equal(result.completed.some((entry) => entry.workItem?.id === "00000000-0000-4000-8000-000000000033"), true);
  assert.equal(JSON.stringify(result).includes("00000000-0000-4000-8000-000000000034"), false);
  assert.equal(result.today.length > 0 || result.needsYou.some((entry) => !entry.workItem), true);
  const oldOnly = buildMyDayData({ ...input, workItems: [], workItemsUnavailable: true });
  assert.equal(oldOnly.workItemsUnavailable, true);
  assert.equal(oldOnly.summary.workflowCount, 1);
  const durableOnly = buildMyDayData({ ...input, workflows: [], workflowDataUnavailable: true });
  assert.equal(durableOnly.needsYou.filter((entry) => entry.workItem).length, 1);
  assert.equal(durableOnly.workflowDataUnavailable, true);
  assert.equal(buildMyDayData({ ...input, workflows: [], workItems: [] }).needsYou.length, 0);
});

test("migration keeps browser access read-only and assignment database-enforced", async () => {
  const sql = await readFile("supabase/migrations/20260926121814_work_os_durable_work_items.sql", "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /workspace_id uuid not null/);
  assert.match(sql, /assignee_user_id uuid not null/);
  assert.match(sql, /foreign key \(workspace_id, assignee_user_id\)[\s\S]*?references public\.workspace_memberships\(workspace_id, user_id\)/);
  assert.match(sql, /work_items_status_check/);
  assert.match(sql, /work_items_priority_check/);
  assert.match(sql, /work_items_source_id_check/);
  assert.match(sql, /work_items_resolution_check/);
  assert.match(sql, /on delete cascade/);
  assert.match(sql, /create unique index work_items_source_dedupe_idx/);
  assert.match(sql, /workspace_id, source_type, coalesce\(source_id, ''\), dedupe_key/);
  assert.match(sql, /alter table public\.work_items force row level security/);
  assert.match(sql, /revoke all on table public\.work_items from public, anon, authenticated/);
  assert.match(sql, /grant select on table public\.work_items to authenticated/);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete).*to authenticated/);
  assert.match(sql, /assignee_user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /workspaces_created_by_idx/);
  assert.doesNotMatch(sql, /security definer/i);
});

test("service and UI never accept browser tenancy, provenance, or handled state", async () => {
  const service = await readFile("lib/work-items.ts", "utf8");
  const loader = await readFile("lib/my-day.ts", "utf8");
  const action = await readFile("app/actions/work-items.ts", "utf8");
  const view = await readFile("components/my-day/my-day-view.tsx", "utf8");
  const exportRoute = await readFile("app/settings/export/route.ts", "utf8");
  assert.match(service, /import "server-only"/);
  assert.match(service, /resolveTrustedWorkspaceMembership/);
  assert.match(service, /\.eq\("workspace_id", auth\.workspace\.id\)/);
  assert.match(service, /\.eq\("assignee_user_id", auth\.user\.id\)/);
  assert.match(service, /\.eq\("status", from\)/);
  assert.match(service, /\.eq\("status", "succeeded"\)/);
  assert.match(service, /\.eq\("is_default", true\)/);
  assert.match(service, /"needs_you", "in_progress", "waiting", "blocked", "handled"/);
  assert.match(action, /EmployeeWorkUpdateSchema\.safeParse/);
  assert.doesNotMatch(action, /createWorkItem|markWorkItemHandled/);
  assert.match(view, /name="to" value="waiting"/);
  assert.match(view, /name="to" value="done"/);
  assert.match(view, /Handled by CrazyLoops/);
  assert.match(exportRoute, /workItems: workItemResult\.data/);
  assert.match(loader, /workItemsUnavailable: workItems\.unavailable/);
  assert.match(loader, /workflowDataUnavailable: true/);
});
