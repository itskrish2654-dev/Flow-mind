import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ApprovalActionSnapshotSchema,
  CreateApprovalSchema,
  DecideApprovalSchema,
  approvalSnapshotForStorage,
  createApprovalWithStore,
  decideApprovalWithStore,
  type ApprovalCreateStore,
  type ApprovalDecisionStore,
  type ApprovalRequest,
} from "../lib/approvals-core";
import { buildMyDayData } from "../lib/my-day-model";
import type { WorkItem } from "../lib/work-items-core";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const workspaceA = "00000000-0000-4000-8000-000000000010";
const workspaceB = "00000000-0000-4000-8000-000000000020";
const workItemId = "00000000-0000-4000-8000-000000000030";
const approvalId = "00000000-0000-4000-8000-000000000040";
const now = "2026-09-27T08:00:00.000Z";

const snapshot = {
  version: 1 as const,
  operationKey: "internal.prepare_reply",
  target: { kind: "internal_record" as const, label: "Prepared reply", reference: "draft-1" },
  parameters: [{ name: "subject", label: "Subject", value: "Follow-up" }],
};

const createInput = {
  actorUserId: userA,
  workItemId,
  approverUserId: userA,
  originType: "internal" as const,
  requestKey: "draft-1-revision-1",
  actionTitle: "Approve this reply",
  actionSummary: "A reply is prepared for review.",
  approvalReason: "Sending requires your decision.",
  capabilityId: "internal.prepare_reply",
  actionSnapshot: snapshot,
};

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: approvalId,
    workspace_id: workspaceA,
    work_item_id: workItemId,
    approver_user_id: userA,
    requested_by_user_id: userA,
    origin_type: "internal",
    source_id: null,
    request_key: "draft-1-revision-1",
    action_title: "Approve this reply",
    action_summary: "A reply is prepared for review.",
    approval_reason: "Sending requires your decision.",
    capability_id: "internal.prepare_reply",
    action_snapshot: snapshot,
    status: "pending",
    decided_by_user_id: null,
    decided_at: null,
    rejection_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: workItemId, workspace_id: workspaceA, assignee_user_id: userA,
    title: "Approve this reply", summary: "Review the prepared reply.",
    why_it_matters: "A decision is required.", suggested_action: "Review proposal.",
    status: "needs_you", priority: "normal", due_at: null,
    status_reason: null, status_actor_user_id: null,
    source_type: "internal", source_id: null, source_label: "Prepared work",
    dedupe_key: "draft-1", created_at: now, updated_at: now, resolved_at: null,
    goal_id: null, goal_plan_item_id: null,
    ...overrides,
  };
}

test("approval creation accepts only a bounded structured proposal and no caller tenancy", () => {
  assert.equal(CreateApprovalSchema.safeParse(createInput).success, true);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, workspaceId: workspaceB }).success, false);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, status: "approved" }).success, false);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, actionTitle: "x".repeat(181) }).success, false);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, requestKey: "x".repeat(161) }).success, false);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, capabilityId: "different.action" }).success, false);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, originType: "workflow" }).success, false);
  assert.equal(CreateApprovalSchema.safeParse({ ...createInput, actionSnapshot: { ...snapshot, parameters: [{ name: "api_key", label: "Key", value: "value" }] } }).success, false);
  assert.equal(ApprovalActionSnapshotSchema.safeParse({ ...snapshot, parameters: [{ name: "note", label: "Note", value: "Bearer abcdef" }] }).success, false);
  assert.equal(ApprovalActionSnapshotSchema.safeParse({ ...snapshot, parameters: [{ name: "body", label: "Body", value: "x".repeat(501) }] }).success, false);
  assert.equal(ApprovalActionSnapshotSchema.safeParse({ ...snapshot, extra: "not permitted" }).success, false);
  const copied = approvalSnapshotForStorage(snapshot);
  snapshot.parameters[0].value = "Changed after approval creation";
  assert.equal(JSON.stringify(copied).includes("Follow-up"), true);
  assert.equal(JSON.stringify(copied).includes("Changed after"), false);
  snapshot.parameters[0].value = "Follow-up";
});

test("trusted creation derives tenancy, rejects unrelated work and assignees, and dedupes exact retries", async () => {
  const rows: ApprovalRequest[] = [];
  const store: ApprovalCreateStore = {
    async resolveWorkspace(actorUserId) { return actorUserId === userA ? workspaceA : workspaceB; },
    async isApproverMember(workspaceId, approverUserId) { return workspaceId === workspaceA && approverUserId === userA; },
    async findWorkItem(id, workspaceId) { return id === workItemId && workspaceId === workspaceA ? workItem() : null; },
    async insertAtomically(value, workspaceId, storedSnapshot) {
      const existing = rows.find((row) => row.workspace_id === workspaceId && row.origin_type === value.originType
        && row.source_id === (value.sourceId ?? null) && row.request_key === value.requestKey);
      if (existing) {
        return existing.action_snapshot === storedSnapshot || JSON.stringify(existing.action_snapshot) === JSON.stringify(storedSnapshot)
          ? existing : null;
      }
      const created = approval({ workspace_id: workspaceId, action_snapshot: storedSnapshot });
      rows.push(created);
      return created;
    },
  };
  const first = await createApprovalWithStore(createInput, store);
  const retry = await createApprovalWithStore(createInput, store);
  assert.equal(first.id, retry.id);
  assert.equal(rows.length, 1);
  await assert.rejects(() => createApprovalWithStore({ ...createInput, actorUserId: userB }, store), /member/);
  await assert.rejects(() => createApprovalWithStore({ ...createInput, approverUserId: userB }, store), /member/);
  await assert.rejects(() => createApprovalWithStore({ ...createInput, workItemId: "00000000-0000-4000-8000-000000000099" }, store), /work item/);
  await assert.rejects(() => createApprovalWithStore({ ...createInput, originType: "system" }, store), /work item/);
  await assert.rejects(() => createApprovalWithStore({ ...createInput, actionSnapshot: { ...snapshot, parameters: [{ name: "subject", label: "Subject", value: "Changed" }] } }, store), /could not be created/);
  assert.equal(rows.length, 1);
});

test("decision input is minimal, rejection text bounded, and terminal choices closed", () => {
  assert.equal(DecideApprovalSchema.safeParse({ id: approvalId, decision: "approved" }).success, true);
  assert.equal(DecideApprovalSchema.safeParse({ id: approvalId, decision: "rejected", rejectionReason: "Not ready" }).success, true);
  assert.equal(DecideApprovalSchema.safeParse({ id: approvalId, decision: "rejected", rejectionReason: "x".repeat(501) }).success, false);
  assert.equal(DecideApprovalSchema.safeParse({ id: approvalId, decision: "approved", rejectionReason: "Surprise" }).success, false);
  assert.equal(DecideApprovalSchema.safeParse({ id: approvalId, decision: "handled" }).success, false);
  assert.equal(DecideApprovalSchema.safeParse({ id: approvalId, decision: "approved", approverUserId: userB }).success, false);
});

function decisionStore() {
  let row = approval();
  let item = workItem();
  const store: ApprovalDecisionStore = {
    async findInWorkspace(id, workspaceId) {
      return id === row.id && workspaceId === row.workspace_id ? { ...row } : null;
    },
    async commitAtomically(input) {
      // Deterministic analogue of the database transaction's locked compare-and-set.
      if (row.id !== input.id || row.status !== "pending" || item.status !== "needs_you") return null;
      if (input.decision === "cancelled" ? row.requested_by_user_id !== input.actorUserId : row.approver_user_id !== input.actorUserId) return null;
      row = approval({ ...row, status: input.decision, decided_by_user_id: input.actorUserId, decided_at: now, rejection_reason: input.rejectionReason });
      item = workItem({ ...item, status: "done", resolved_at: now });
      return { ...row };
    },
  };
  return { store, current: () => ({ row, item }) };
}

test("assigned user can approve or reject, and a decision resolves—not handles—the linked work item", async () => {
  for (const decision of ["approved", "rejected"] as const) {
    const { store, current } = decisionStore();
    const result = await decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceA, decision, rejectionReason: decision === "rejected" ? "Please revise" : null }, store);
    assert.equal(result.status, decision);
    assert.equal(result.decided_by_user_id, userA);
    assert.equal(current().item.status, "done");
    assert.notEqual(current().item.status, "handled");
    await assert.rejects(() => decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceA, decision }, store), /already decided/);
  }
});

test("cross-user/workspace IDs fail and approve-vs-reject race has one winner", async () => {
  const { store, current } = decisionStore();
  await assert.rejects(() => decideApprovalWithStore({ id: approvalId, actorUserId: userB, workspaceId: workspaceA, decision: "approved" }, store), /unavailable/);
  await assert.rejects(() => decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceB, decision: "approved" }, store), /unavailable/);
  const outcomes = await Promise.allSettled([
    decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceA, decision: "approved" }, store),
    decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceA, decision: "rejected" }, store),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(current().item.status, "done");
});

test("trusted cancellation belongs only to requester and resolves the item", async () => {
  const { store, current } = decisionStore();
  await assert.rejects(() => decideApprovalWithStore({ id: approvalId, actorUserId: userB, workspaceId: workspaceA, decision: "cancelled" }, store), /unavailable/);
  const result = await decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceA, decision: "cancelled" }, store);
  assert.equal(result.status, "cancelled");
  assert.equal(current().item.status, "done");
});

test("an invalid stored proposal cannot be approved even with the correct approver ID", async () => {
  const { store } = decisionStore();
  const unsafe: ApprovalDecisionStore = {
    ...store,
    async findInWorkspace() { return approval({ action_snapshot: { version: 1 } }); },
  };
  await assert.rejects(() => decideApprovalWithStore({ id: approvalId, actorUserId: userA, workspaceId: workspaceA, decision: "approved" }, unsafe), /could not be verified/);
});

test("My Day shows pending approval once and preserves other content/failure isolation", () => {
  const base = { userId: userA, workspaceId: workspaceA, workflows: [], executions: [], connections: [], workItems: [workItem(), workItem({ id: "00000000-0000-4000-8000-000000000031", title: "Other task" })] };
  const data = buildMyDayData({ ...base, approvals: [approval(), approval({ id: "00000000-0000-4000-8000-000000000041", approver_user_id: userB }), approval({ id: "00000000-0000-4000-8000-000000000042", status: "approved" })] });
  assert.equal(data.approvals.length, 1);
  assert.equal(data.approvals[0].title, "Approve this reply");
  assert.equal(data.approvals[0].target, "Prepared reply");
  assert.equal(data.needsYou.filter((entry) => entry.workItem).length, 1);
  assert.equal(data.needsYou.some((entry) => entry.workItem?.id === workItemId), false);
  const unavailable = buildMyDayData({ ...base, approvalsUnavailable: true });
  assert.equal(unavailable.approvalsUnavailable, true);
  assert.equal(unavailable.needsYou.filter((entry) => entry.workItem).length, 2);
  const invalid = buildMyDayData({ ...base, approvals: [approval({ action_snapshot: { version: 1 } })] });
  assert.equal(invalid.approvalsUnavailable, true);
  assert.equal(invalid.needsYou.filter((entry) => entry.workItem).length, 2);
});

test("migration enforces immutable proposal, atomic transition, idempotency, tenant isolation, and restricted grants", async () => {
  const sql = await readFile("supabase/migrations/20260927053856_work_os_durable_approvals.sql", "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /foreign key \(workspace_id, work_item_id, approver_user_id\)/);
  assert.match(sql, /references public\.work_items\(workspace_id, id, assignee_user_id\)/);
  assert.match(sql, /approval_requests_one_pending_per_item_idx/);
  assert.match(sql, /v_item\.source_type <> p_origin_type or v_item\.source_id is distinct from p_source_id/);
  assert.match(sql, /approval_requests_dedupe_idx/);
  assert.match(sql, /if found then[\s\S]*Approval idempotency key belongs to another proposal[\s\S]*return query select \* from public\.approval_requests where id = v_existing\.id/);
  assert.match(sql, /create trigger approval_request_update_guard/);
  assert.match(sql, /create trigger work_item_pending_approval_guard/);
  assert.match(sql, /for update/g);
  assert.match(sql, /update public\.approval_requests set status = p_decision/);
  assert.match(sql, /update public\.work_items set status = 'done'/);
  assert.match(sql, /approval_requests[\s\S]*force row level security/);
  assert.match(sql, /revoke all on table public\.approval_requests from public, anon, authenticated/);
  assert.match(sql, /grant select on table public\.approval_requests to authenticated/);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete).*approval_requests.*authenticated/);
  assert.match(sql, /approver_user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /if current_user <> 'service_role'/);
  assert.match(sql, /revoke all on function public\.decide_approval_request/);
  assert.doesNotMatch(sql, /security definer/i);
});

test("browser action cannot create/cancel or supply workspace, approver, or proposal", async () => {
  const action = await readFile("app/actions/approvals.ts", "utf8");
  const service = await readFile("lib/approvals.ts", "utf8");
  const loader = await readFile("lib/my-day.ts", "utf8");
  const view = await readFile("components/my-day/my-day-view.tsx", "utf8");
  const exportRoute = await readFile("app/settings/export/route.ts", "utf8");
  assert.match(action, /"use server"/);
  assert.match(action, /id: z\.uuid\(\)/);
  assert.match(action, /decision: z\.enum\(\["approved", "rejected"\]\)/);
  assert.doesNotMatch(action, /createApprovalRequest|cancelApprovalRequest|workspaceId|approverUserId|actionSnapshot/);
  assert.match(service, /import "server-only"/);
  assert.match(service, /getAuthenticatedContext/);
  assert.match(service, /resolveTrustedWorkspaceMembership/);
  assert.match(service, /create_approval_request/);
  assert.match(service, /decide_approval_request/);
  assert.match(loader, /approvalsUnavailable: approvals\.unavailable/);
  assert.match(view, /title="Approvals"/);
  assert.match(view, /value="approved"/);
  assert.match(view, /value="rejected"/);
  assert.match(exportRoute, /\.eq\("approver_user_id", auth\.user\.id\)/);
  assert.match(exportRoute, /approvals: approvalResult\.data/);
});
