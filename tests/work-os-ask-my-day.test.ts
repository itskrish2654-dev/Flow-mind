import assert from "node:assert/strict";
import test from "node:test";

import { buildAskMyDayItems, buildAskMyDayToolResult } from "../lib/ask-my-day";
import type { ApprovalRequest } from "../lib/approvals-core";
import { buildMyDayData } from "../lib/my-day-model";
import type { WorkItem } from "../lib/work-items-core";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const workspaceA = "00000000-0000-4000-8000-000000000010";
const workspaceB = "00000000-0000-4000-8000-000000000020";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function workItem(value: number, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: uuid(value),
    workspace_id: workspaceA,
    assignee_user_id: userA,
    title: `Work item ${value}`,
    summary: `Summary ${value}`,
    why_it_matters: `Why ${value}`,
    suggested_action: `Action ${value}`,
    status: "needs_you",
    priority: "normal",
    due_at: null,
    source_type: "internal",
    source_id: null,
    source_label: "Acceptance fixture",
    dedupe_key: `work-item-${value}`,
    created_at: `2026-09-30T08:${String(value % 60).padStart(2, "0")}:00.000Z`,
    updated_at: `2026-09-30T08:${String(value % 60).padStart(2, "0")}:00.000Z`,
    resolved_at: null,
    ...overrides,
  };
}

function approval(value: number, item: WorkItem): ApprovalRequest {
  return {
    id: uuid(10_000 + value),
    workspace_id: workspaceA,
    work_item_id: item.id,
    approver_user_id: userA,
    requested_by_user_id: userA,
    origin_type: "internal",
    source_id: null,
    request_key: `approval-${value}`,
    action_title: `Approve item ${value}`,
    action_summary: `Review proposed action ${value}.`,
    approval_reason: "A decision is required.",
    capability_id: "internal.prepare_reply",
    action_snapshot: {
      version: 1,
      operationKey: "internal.prepare_reply",
      target: { kind: "internal_record", label: `Target ${value}`, reference: `target-${value}` },
      parameters: [{ name: "subject", label: "Subject", value: `Proposal ${value}` }],
    },
    status: "pending",
    decided_by_user_id: null,
    decided_at: null,
    rejection_reason: null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function myDay(workItems: WorkItem[], approvals: ApprovalRequest[] = []) {
  return buildMyDayData({
    userId: userA,
    workspaceId: workspaceA,
    workflows: [],
    executions: [],
    connections: [],
    workItems,
    approvals,
  });
}

test("Ask restores an approval-linked high-priority Work Item without changing My Day presentation dedupe", () => {
  const launch = workItem(100, {
    title: "Review launch proposal",
    summary: "Review the launch proposal before Friday.",
    why_it_matters: "The launch decision blocks the release.",
    suggested_action: "Review the proposal.",
    priority: "high",
  });
  const supplier = workItem(101, { title: "Review supplier options" });
  const data = myDay([launch, supplier], [approval(100, launch)]);

  assert.equal(data.needsYou.some((item) => item.workItem?.id === launch.id), false);
  assert.equal(data.startWith?.workItem?.id, supplier.id);

  const result = buildAskMyDayToolResult({
    data,
    currentWorkItems: [launch, supplier],
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.deepEqual(result.records.map((record) => record.reference.entityId), [launch.id, supplier.id]);
  assert.equal(result.records.filter((record) => record.reference.entityId === launch.id).length, 1);
  assert.equal(result.records[0].reference.label, "Review launch proposal");
  assert.equal(result.records[0].reference.href, `/my-day#work-item-${launch.id}`);
  assert.equal(result.records[0].facts.priority, "high");
  assert.equal(result.records[0].facts.whyItMatters, "The launch decision blocks the release.");
});

test("Ask merge preserves unlinked items exactly once and excludes completed or off-scope rows", () => {
  const owned = workItem(200, { title: "Owned task", priority: "high" });
  const completed = workItem(201, { status: "done" });
  const otherUser = workItem(202, { assignee_user_id: userB });
  const otherWorkspace = workItem(203, { workspace_id: workspaceB });
  const data = myDay([owned]);

  const items = buildAskMyDayItems({
    data,
    currentWorkItems: [owned, completed, otherUser, otherWorkspace],
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.deepEqual(items.map((item) => item.workItem?.id), [owned.id]);
});

test("Ask applies its final record bound after restoring missing approval-linked records", () => {
  const items = Array.from({ length: 14 }, (_, index) => workItem(300 + index, {
    title: `Priority task ${index}`,
    priority: "high",
  }));
  const data = myDay(items, items.map((item, index) => approval(300 + index, item)));

  const result = buildAskMyDayToolResult({
    data,
    currentWorkItems: items,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.equal(data.needsYou.length, 0);
  assert.equal(result.records.length, 12);
  assert.deepEqual(
    result.records.map((record) => record.reference.entityId),
    [...items]
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || left.id.localeCompare(right.id))
      .slice(0, 12)
      .map((item) => item.id),
  );
});

test("pending approval and restored Work Item remain separate grounded records", () => {
  const item = workItem(400, { title: "Review customer response", priority: "high" });
  const pending = approval(400, item);
  const data = myDay([item], [pending]);
  const myDayResult = buildAskMyDayToolResult({
    data,
    currentWorkItems: [item],
    userId: userA,
    workspaceId: workspaceA,
  });

  assert.equal(data.approvals.length, 1);
  assert.equal(data.approvals[0].id, pending.id);
  assert.equal(myDayResult.records.length, 1);
  assert.equal(myDayResult.records[0].reference.entityId, item.id);
  assert.equal(myDayResult.records[0].facts.priority, "high");
});
