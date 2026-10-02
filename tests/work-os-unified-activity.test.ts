import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACTIVITY_FILTER_TYPES,
  activityEventTypesForQuestion,
  activityLabel,
  activityOutcome,
  activitySourceHref,
  parseActivityCursor,
  parseActivityFilter,
  type ActivityEvent,
} from "../lib/activity-core";
import { AskReferenceSchema, selectAskTools } from "../lib/ask-core";

const root = process.cwd();
const migration = readFileSync(`${root}/supabase/migrations/20261002000000_work_os_unified_activity.sql`, "utf8");
const retentionMigration = readFileSync(`${root}/supabase/migrations/20261002000100_work_os_activity_member_departure.sql`, "utf8");
const activityService = readFileSync(`${root}/lib/activity.ts`, "utf8");
const askTools = readFileSync(`${root}/lib/ask-tools.ts`, "utf8");
const activityPage = readFileSync(`${root}/app/activity/page.tsx`, "utf8");
const loginForm = readFileSync(`${root}/components/login-form.tsx`, "utf8");
const resetForm = readFileSync(`${root}/components/reset-password-form.tsx`, "utf8");
const secret = "DO_NOT_LEAK_PRIVATE_EMAIL_BODY_OR_TOKEN";
const userA = "00000000-0000-4000-8000-000000000001";
const workspaceA = "00000000-0000-4000-8000-000000000010";
const actionId = "00000000-0000-4000-8000-000000000040";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 1, workspace_id: workspaceA, owner_user_id: userA, actor_user_id: userA,
    visibility: "private", event_type: "action_succeeded", source_type: "action",
    source_id: actionId, work_item_id: actionId, approval_request_id: actionId,
    action_execution_id: actionId, workflow_id: null, event_key: "action:1:succeeded",
    occurred_at: "2026-10-02T08:00:00Z", ...overrides,
  };
}

test("Activity language distinguishes approval, provider confirmation, failure and uncertainty", () => {
  assert.equal(activityOutcome(event({ event_type: "approval_approved" })), "Approved, not yet delivered");
  assert.match(activityLabel(event()), /Provider confirmed/);
  assert.equal(activityOutcome(event({ event_type: "action_ambiguous" })), "Outcome uncertain");
  assert.equal(activityOutcome(event({ event_type: "action_failed" })), "Failed");
  assert.equal(activityOutcome(event({ event_type: "work_item_waiting" })), "Waiting");
  assert.equal(activityOutcome(event({ event_type: "work_item_created" })), "Created");
  assert.equal(activityOutcome(event({ event_type: "work_item_done" })), "Completed");
  assert.equal(activityOutcome(event({ event_type: "approval_cancelled" })), "Cancelled");
  assert.equal(activityLabel(event({ visibility: "workspace" })), "A teammate's approved action completed");
});

test("filter and cursor inputs are bounded and never accepted as query fragments", () => {
  assert.equal(parseActivityFilter("actions"), "actions");
  assert.equal(parseActivityFilter("other' OR true"), "all");
  assert.equal(parseActivityCursor("123"), 123);
  assert.equal(parseActivityCursor("0"), null);
  assert.equal(parseActivityCursor("1,2"), null);
  assert.equal(parseActivityCursor(String(Number.MAX_SAFE_INTEGER + 1)), null);
  assert.ok(ACTIVITY_FILTER_TYPES.attention.includes("action_ambiguous"));
  assert.ok(ACTIVITY_FILTER_TYPES.approvals.includes("approval_rejected"));
  assert.ok(ACTIVITY_FILTER_TYPES.workflows.includes("workflow_succeeded"));
  assert.deepEqual(activityEventTypesForQuestion("Which actions failed today?"), ["action_failed"]);
  assert.deepEqual(activityEventTypesForQuestion("What actions had uncertain outcomes?"), ["action_ambiguous"]);
  assert.deepEqual(activityEventTypesForQuestion("What did CrazyLoops do today?"), undefined);
});

test("company-safe summaries never provide another member's private source link", () => {
  assert.equal(activitySourceHref(event({ visibility: "workspace" })), null);
  assert.equal(activitySourceHref(event()), `/my-day#work-item-${actionId}`);
  assert.equal(activitySourceHref(event({ work_item_id: null, workflow_id: actionId })), `/dashboard/projects/${actionId}`);
});

test("database records fixed event kinds atomically, dedupes retries, and never copies source payload", () => {
  assert.match(migration, /create table public\.activity_events/);
  assert.match(migration, /constraint activity_events_identity_unique unique \(workspace_id, event_key\)/);
  assert.match(migration, /on conflict \(workspace_id, event_key\) do nothing/g);
  assert.match(migration, /after insert or update on public\.work_items/);
  assert.match(migration, /after insert or update on public\.approval_requests/);
  assert.match(migration, /after insert or update on public\.action_executions/);
  assert.match(migration, /after insert or update on public\.workflow_executions/);
  assert.match(migration, /activity_events_immutable before update/);
  assert.doesNotMatch(migration, /action_snapshot|input_data|output_data|provider_reference_id|provider_reference|result_summary/);
  assert.doesNotMatch(migration, /(?:from|join|update|insert into|grant select on) public\.operational_events/i);
});

test("member departure revokes access without deleting company Activity", () => {
  assert.match(retentionMigration, /drop constraint activity_events_owner_membership_fkey/);
  assert.match(retentionMigration, /references auth\.users\(id\) on delete cascade/);
  assert.match(retentionMigration, /activity_events_owner_user_idx/);
  assert.match(migration, /membership\.is_default/);
});

test("browser cannot mutate Activity, membership and private owner govern reads", () => {
  assert.match(migration, /revoke all on public\.activity_events from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.activity_events to authenticated/);
  assert.match(migration, /owner_user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /membership\.workspace_id = activity_events\.workspace_id/);
  assert.match(migration, /membership\.is_default/);
  assert.match(migration, /revoke all on function public\.record_action_activity\(\) from public, anon, authenticated/);
  assert.match(activityService, /event\.visibility !== "private" \|\| event\.owner_user_id !== auth\.user\.id/);
  assert.match(activityService, /\.eq\("requester_user_id", auth\.user\.id\)/);
  assert.match(activityService, /\.eq\("approver_user_id", auth\.user\.id\)/);
  assert.doesNotMatch(activityPage, /action_snapshot|provider_reference_id|connection_id|idempotency_key/);
  assert.ok(!activityPage.includes(secret));
});

test("Ask routes human Activity questions to the durable ledger with safe citations", () => {
  assert.ok(selectAskTools("What did CrazyLoops do today?").includes("recent_activity"));
  assert.ok(selectAskTools("Which actions failed today?").includes("recent_activity"));
  assert.ok(selectAskTools("What actions had uncertain outcomes?").includes("recent_activity"));
  assert.ok(selectAskTools("What happened after I approved the last action?").includes("recent_activity"));
  assert.match(askTools, /listCurrentWorkspaceActivity\("all", null, activityEventTypesForQuestion\(question\)\)/);
  assert.match(askTools, /href: `\/activity\?entry=\$\{event\.id\}`/);
  assert.equal(AskReferenceSchema.safeParse({
    kind: "activity", entityId: actionId, label: "Provider confirmed", href: "/activity?entry=1",
  }).success, true);
  assert.equal(AskReferenceSchema.safeParse({
    kind: "activity", entityId: actionId, label: "Unsafe", href: "https://evil.example/",
  }).success, false);
});

test("credential forms cannot fall back to GET before hydration", () => {
  assert.match(loginForm, /<form method="post" onSubmit=/);
  assert.match(resetForm, /<form method="post" onSubmit=/);
});
