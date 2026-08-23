import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { oauthReturnWorkflowId, safeOAuthReturnPath, withOAuthResult } from "../lib/connectors/oauth-return";
import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { getWorkflowReadiness } from "../lib/workflow-readiness";

const workflowId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";

function slackWorkflow(boundConnectionId?: string): CompiledWorkflow {
  return {
    workflowName: "Slack update",
    summary: "Send a saved update to the selected Slack channel.",
    steps: [{
      id: "send-slack-update",
      type: "connector_action",
      capabilityId: "slack.send_message",
      capabilityStatus: "supported",
      title: "Send the update to Slack",
      description: "Sends the update to the selected workspace and channel.",
      inputsRequired: [{ key: "channel", label: "Slack channel", type: "text", required: true }],
      config: {
        connector: {
          connectorId: "slack",
          operationKind: "action",
          operationKey: "send_channel_message",
          operationVersion: 1,
          ...(boundConnectionId ? { connectionId: boundConnectionId } : {}),
          mappings: [],
        },
      },
    }],
  };
}

test("D3.4-C OAuth return paths allow only owned-route shapes and preserve step context", () => {
  const projectPath = `/dashboard/projects/${workflowId}?step=send-slack-update`;
  assert.equal(safeOAuthReturnPath(projectPath), projectPath);
  assert.equal(oauthReturnWorkflowId(projectPath), workflowId);
  assert.equal(withOAuthResult(projectPath, "connected", "slack"), `${projectPath}&connected=slack`);

  for (const unsafe of [
    "https://attacker.example/dashboard",
    "//attacker.example/dashboard",
    "/api/connectors/oauth/slack/callback",
    "/dashboard/projects/not-a-uuid",
    `/dashboard/projects/${workflowId}?next=https://attacker.example`,
    `/dashboard/projects/${workflowId}?step=bad%2Fstep`,
    "/connections?next=https://attacker.example",
  ]) {
    assert.equal(safeOAuthReturnPath(unsafe), unsafe.includes(`/dashboard/projects/${workflowId}`) ? `/dashboard/projects/${workflowId}` : "/connections");
  }
});

test("D3.4-C readiness asks for an explicit account when one is available", () => {
  const readiness = getWorkflowReadiness({
    workflow: slackWorkflow(),
    workflowId,
    values: {},
    configuredCredentialKeys: new Set(),
    connections: [{ id: connectionId, provider: "slack", status: "connected" }],
  });
  assert.deepEqual(readiness.attention.map((item) => item.actionLabel), ["Choose Slack account", "Choose Slack channel"]);
  assert.equal(readiness.testReady, false);
});

test("D3.4-C readiness preserves exact bindings and marks broken connections for reconnect", () => {
  const readiness = getWorkflowReadiness({
    workflow: slackWorkflow(connectionId),
    workflowId,
    values: { "send-slack-update-channel": "C123" },
    configuredCredentialKeys: new Set(),
    connections: [{ id: connectionId, provider: "slack", status: "expired" }],
  });
  assert.deepEqual(readiness.attention.map((item) => item.actionLabel), ["Reconnect Slack"]);
  assert.match(readiness.attention[0]?.description ?? "", /still bound/i);
});

test("D3.4-C stale provider resources block test and activation without exposing IDs", () => {
  const readiness = getWorkflowReadiness({
    workflow: slackWorkflow(connectionId),
    workflowId,
    values: { "send-slack-update-channel": "C123" },
    configuredCredentialKeys: new Set(),
    connections: [{ id: connectionId, provider: "slack", status: "connected" }],
    invalidInputIds: new Set(["send-slack-update-channel"]),
  });
  assert.equal(readiness.testReady, false);
  assert.equal(readiness.activationReady, false);
  assert.equal(readiness.attention[0]?.actionLabel, "Choose Slack channel");
  assert.doesNotMatch(JSON.stringify(readiness.attention), /C123|connectionId|resourceId/);
});

test("D3.4-C OAuth continuation stays owner-bound and cancellation consumes verified state first", async () => {
  const [start, callback] = await Promise.all([
    readFile("app/api/connectors/oauth/[connectorId]/start/route.ts", "utf8"),
    readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8"),
  ]);
  assert.match(start, /oauthReturnWorkflowId/);
  assert.match(start, /\.eq\("id", returnWorkflowId\)\.eq\("user_id", user\.id\)/);
  assert.match(start, /\.eq\("id", connectionId\)\.eq\("user_id", user\.id\)/);
  assert.ok(callback.indexOf("consumeOAuthState") < callback.indexOf("if (providerError || !code)"));
  assert.match(callback, /withOAuthResult\(returnPath, "connection_error"/);
  assert.doesNotMatch(callback, /error_description/);
  assert.doesNotMatch(callback, /withOAuthResult\([^\n]*(?:accessToken|refreshToken|code)/);
});

test("D3.4-C dependency warnings include current drafts and published production versions once per workflow", async () => {
  const source = await readFile("lib/connectors/connection-view.ts", "utf8");
  assert.match(source, /select\("id,current_version_id,published_version_id"\)/);
  assert.match(source, /\[workflow\.current_version_id, workflow\.published_version_id\]/);
  assert.match(source, /const connectionIds = new Set<string>\(\)/);
});

test("D3.4-C workflow setup exposes loading, refresh, stale-resource, and safe account labels", async () => {
  const [workspace, connections] = await Promise.all([
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/connections-list.tsx", "utf8"),
  ]);
  for (const copy of [
    "Loading connected accounts…",
    "Loading Slack channels…",
    "Refresh channels",
    "Refresh resources",
    "no longer available",
    "Needs attention",
    "Connected",
  ]) assert.match(`${workspace}\n${connections}`, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(workspace, /Choose connected account/);
  assert.match(workspace, /CrazyLoops never selects[\s\S]*first connected account automatically/);
  assert.match(workspace, /return=\$\{encodeURIComponent\(workflowReturnPath\)\}/);
  assert.doesNotMatch(`${workspace}\n${connections}`, /sessionStorage|access_token|refresh_token/i);
});

test("D3.4-C connection changes remain immutable draft changes until explicit publication", async () => {
  const [actions, workspace, journey] = await Promise.all([
    readFile("app/actions/connections.ts", "utf8"),
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/workflow-journey-panel.tsx", "utf8"),
  ]);
  assert.match(actions, /createImmutableWorkflowVersion/);
  assert.match(actions, /loadWorkflowSnapshot\(admin, request\.data\.workflowId, user\.id\)/);
  assert.match(workspace, /if \(published && !id\.startsWith\("test_input:"\)\) setHasUnpublishedChanges\(true\)/);
  assert.match(journey, /Publish changes/);
});

test("D3.4-C publication persists current non-secret setup before the atomic cutover", async () => {
  const [publication, workspace] = await Promise.all([
    readFile("app/actions/workflow.ts", "utf8"),
    readFile("components/automation-workspace.tsx", "utf8"),
  ]);
  const action = publication.slice(
    publication.indexOf("export async function setWorkflowPublication"),
    publication.indexOf("export async function getWorkflowConnectorEndpoints"),
  );
  assert.match(workspace, /setWorkflowPublication\([\s\S]*publish \? values : undefined/);
  assert.match(action, /sanitizeSetupConfig/);
  assert.match(action, /!key\.startsWith\("test_input:"\)/);
  assert.match(action, /createImmutableWorkflowVersion/);
  assert.match(action, /loadWorkflowSnapshot\(admin, request\.data\.workflowId, auth\.user\.id\)/);
  assert.match(action, /p_expected_current_version_id: currentVersionId/);
  assert.match(action, /admin\.rpc\("publish_workflow_version"/);
});
