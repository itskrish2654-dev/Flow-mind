import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ActionPreviewSchema,
  actionApprovalDisposition,
  actionOutcomeSummary,
  approvalSnapshotFromPreview,
} from "../lib/action-execution-core";
import { AskResponseMetadataSchema, selectAskTools } from "../lib/ask-core";
import { getCapability } from "../lib/capability-registry";
import { getConnectorOperation } from "../lib/connectors/registry";
import type { ConnectorActionHandler } from "../lib/connectors/types";

const connectionId = "00000000-0000-4000-8000-000000000101";
const preview = {
  version: 1 as const,
  capabilityId: "internal.action_acknowledge",
  connectorId: "flowmind_test",
  operationKey: "acknowledge",
  operationVersion: 1,
  connectionId,
  actionTitle: "Run approved acceptance action",
  actionSummary: "Acknowledge the exact approved message.",
  approvalReason: "An external side effect requires human approval.",
  target: { kind: "external_resource" as const, label: "Acceptance connector", reference: connectionId },
  parameters: [{ name: "message", label: "Message", value: "Exact approved content" }],
};

test("action previews and stored approval snapshots are strict, bounded, and secret-free", () => {
  assert.equal(ActionPreviewSchema.safeParse(preview).success, true);
  assert.deepEqual(approvalSnapshotFromPreview(preview), {
    version: 1,
    operationKey: preview.capabilityId,
    target: preview.target,
    parameters: preview.parameters,
  });
  assert.equal(ActionPreviewSchema.safeParse({ ...preview, arbitraryUrl: "https://attacker.invalid" }).success, false);
  assert.equal(ActionPreviewSchema.safeParse({ ...preview, parameters: [{ name: "api_key", label: "Key", value: "value" }] }).success, false);
  assert.equal(ActionPreviewSchema.safeParse({ ...preview, parameters: [{ name: "body", label: "Body", value: "Bearer abcdefghijklmnopqrstuvwxyz" }] }).success, false);
});

test("stale approval decisions are denied while a queued approved action can safely resume", () => {
  assert.equal(actionApprovalDisposition("pending_approval", "approved"), "decide");
  assert.equal(actionApprovalDisposition("pending_approval", "rejected"), "decide");
  assert.equal(actionApprovalDisposition("queued", "approved"), "resume_queued");
  assert.equal(actionApprovalDisposition("queued", "rejected"), "already_decided");
  for (const status of ["executing", "succeeded", "failed", "ambiguous", "rejected", "cancelled"] as const) {
    assert.equal(actionApprovalDisposition(status, "approved"), "already_decided");
    assert.equal(actionApprovalDisposition(status, "rejected"), "already_decided");
  }
  const service = readFileSync("lib/action-executions.ts", "utf8");
  assert.match(service, /if \(disposition === "already_decided"\) throw new Error/);
});

test("Ask metadata accepts only a validated action preview and routes outcome questions to durable action activity", () => {
  assert.equal(AskResponseMetadataSchema.safeParse({
    version: 1, responseType: "action_preview", clarificationRequired: false,
    references: [], actionPreview: preview,
  }).success, true);
  assert.deepEqual(selectAskTools("Did CrazyLoops perform the action?"), ["action_activity"]);
  assert.equal(AskResponseMetadataSchema.safeParse({
    version: 1, responseType: "action_preview", clarificationRequired: false,
    references: [], actionPreview: { ...preview, capabilityId: "invented.execute" }, extra: true,
  }).success, false);
});

test("the authoritative registry exposes only an internal test-only action harness for acknowledgement", () => {
  const capability = getCapability("internal.action_acknowledge");
  assert.ok(capability);
  assert.equal(capability.supported, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, false);
  assert.equal(capability.internalOnly, true);
  assert.equal(capability.plannerVisible, false);
  assert.deepEqual(capability.connectorOperation, {
    connectorId: "flowmind_test", providerFamily: "flowmind_test", operationKind: "action",
    operationKey: "acknowledge", operationVersion: 1,
  });
});

test("the acceptance adapter proves success, provider failure, and ambiguous outcomes without retries", async () => {
  const operation = getConnectorOperation("flowmind_test", "action", "acknowledge", 1);
  assert.ok(operation?.handler);
  const handler = operation.handler as ConnectorActionHandler;
  const context = {
    userId: connectionId, workflowId: connectionId, executionId: connectionId,
    stepId: connectionId, connectionId, idempotencyKey: "action:test",
  };
  const succeeded = await handler({ message: "Exact approved content" }, context);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.acknowledged, true);
  assert.equal(succeeded.externallyDelivered, true);
  const failed = await handler({ message: "__acceptance_fail__" }, context);
  assert.equal(failed.status, "failed");
  assert.equal(failed.externallyDelivered, false);
  const ambiguous = await handler({ message: "__acceptance_ambiguous__" }, context);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.error?.retryable, false);
  assert.match(actionOutcomeSummary("ambiguous"), /could not confirm/i);
});

test("migration enforces durable state separation, service-only mutation, RLS, and one claim", () => {
  const sql = readFileSync("supabase/migrations/20260930181701_work_os_approval_backed_action_execution.sql", "utf8");
  const correction = readFileSync("supabase/migrations/20260930181702_work_os_action_preview_metadata.sql", "utf8");
  const privacy = readFileSync("supabase/migrations/20260930181703_work_os_action_execution_token_privacy.sql", "utf8");
  assert.match(sql, /create table public\.action_executions/);
  assert.match(sql, /status in \([\s\S]*'pending_approval'[\s\S]*'approved'|status in \([\s\S]*'pending_approval'[\s\S]*'queued'/);
  assert.match(sql, /create unique index action_executions_idempotency_idx/);
  assert.match(sql, /status = 'queued'[\s\S]*returning \*/);
  assert.match(sql, /where id = p_execution_id[\s\S]*status = 'queued'/);
  assert.match(sql, /status = case when p_status = 'succeeded' then 'handled' else 'needs_you' end/);
  assert.match(sql, /p_status = 'succeeded'[\s\S]*not p_acknowledged[\s\S]*not p_externally_delivered/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /revoke all on table public\.action_executions from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.create_action_approval[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /current_user <> 'service_role'/);
  assert.match(correction, /response_metadata ->> 'responseType' = 'action_preview'[\s\S]*jsonb_typeof\(response_metadata -> 'actionPreview'\) = 'object'/);
  assert.match(correction, /response_metadata -[\s\S]*'actionPreview'/);
  assert.match(correction, /old\.connection_id is not null and new\.connection_id is null/);
  assert.match(correction, /Action execution connection identity is immutable/);
  assert.match(privacy, /status <> 'executing' and claim_token is null/);
  assert.match(privacy, /revoke select on table public\.action_executions from authenticated/);
  const browserGrant = privacy.match(/grant select \(([\s\S]*?)\) on table public\.action_executions to authenticated/)?.[1] ?? "";
  assert.doesNotMatch(browserGrant, /claim_token|idempotency_key/);
  assert.match(privacy, /set status = p_status, claim_token = null/);
  const service = readFileSync("lib/action-executions.ts", "utf8");
  assert.match(service, /ACTION_EXECUTION_VIEW_COLUMNS/);
  assert.doesNotMatch(service.match(/listCurrentUserActionExecutions[\s\S]*?\n}/)?.[0] ?? "", /select\("\*"\)/);
});

test("approval and Ask UI state approval separately from provider success", () => {
  const ask = readFileSync("components/ask/ask-view.tsx", "utf8");
  const myDay = readFileSync("components/my-day/my-day-view.tsx", "utf8");
  assert.match(ask, /Nothing has been sent or changed yet/);
  assert.match(ask, /requestAskActionApproval/);
  assert.match(myDay, /never treats approval as delivery/);
  assert.match(myDay, /provider success is recorded separately/);
});

test("Company Admin acceptance cleanup recovers interrupted marker-owned fixtures safely", () => {
  const source = readFileSync("e2e/company-workspace-acceptance.spec.ts", "utf8");
  assert.match(source, /cleanupCompanyAcceptanceFixtures\(admin\);[\s\S]*const users/);
  assert.match(source, /acceptance_run === ACCEPTANCE_MARKER/);
  assert.match(source, /ACCEPTANCE_EMAIL\.test/);
  assert.match(source, /membership ownership could not be proven/);
  assert.match(source, /if \(error\) throw new Error\("Acceptance workspaces could not be cleaned up\."\)/);
});
