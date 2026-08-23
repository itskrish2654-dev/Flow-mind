import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { getWorkflowReadiness } from "../lib/workflow-readiness";

function workflowWith(
  steps: CompiledWorkflow["steps"],
): CompiledWorkflow {
  return {
    workflowName: "Customer request workflow",
    summary: "Collect a request and send the useful result where it belongs.",
    steps,
  };
}

const formStep: CompiledWorkflow["steps"][number] = {
  id: "collect-request",
  type: "public_form_trigger",
  capabilityId: "flowmind.public_form",
  capabilityStatus: "supported",
  title: "Collect the customer request",
  description: "Starts when a customer completes your hosted form.",
};

const storeStep: CompiledWorkflow["steps"][number] = {
  id: "save-result",
  type: "store_data",
  capabilityId: "flowmind.store_data",
  capabilityStatus: "supported",
  title: "Save the result in CrazyLoops",
  description: "Keeps the result available in Activity.",
};

test("short configured workflows are ready without manufactured setup", () => {
  const readiness = getWorkflowReadiness({
    workflow: workflowWith([formStep, storeStep]),
    workflowId: "00000000-0000-4000-8000-000000000001",
    values: {},
    configuredCredentialKeys: new Set(),
  });

  assert.equal(readiness.totalSteps, 2);
  assert.equal(readiness.readySteps, 2);
  assert.equal(readiness.testReady, true);
  assert.equal(readiness.activationReady, true);
  assert.deepEqual(readiness.attention, []);
});

test("missing app and resource setup is centralized in customer language", () => {
  const slackStep: CompiledWorkflow["steps"][number] = {
    id: "post-summary",
    type: "connector_action",
    capabilityId: "slack.send_message",
    capabilityStatus: "supported",
    title: "Post the summary in Slack",
    description: "Sends the completed summary to the chosen channel.",
    inputsRequired: [
      { key: "channelId", label: "Channel", type: "text", required: true },
    ],
    config: {
      connector: {
        connectorId: "slack",
        operationKind: "action",
        operationKey: "send_message",
        operationVersion: 1,
        mappings: [],
      },
    },
  };
  const readiness = getWorkflowReadiness({
    workflow: workflowWith([formStep, slackStep]),
    workflowId: "00000000-0000-4000-8000-000000000001",
    values: {},
    configuredCredentialKeys: new Set(),
  });

  assert.equal(readiness.testReady, false);
  assert.equal(readiness.activationReady, false);
  assert.deepEqual(
    readiness.attention.map((item) => item.actionLabel),
    ["Connect Slack", "Choose Slack channel"],
  );
  assert.doesNotMatch(
    readiness.attention.map((item) => `${item.title} ${item.description}`).join(" "),
    /connectionId|channelId|operationKey|credential/i,
  );
});

test("test-only capability can be tested but cannot be activated", () => {
  const testOnlyStep: CompiledWorkflow["steps"][number] = {
    id: "preview-destination",
    type: "connector_action",
    capabilityId: "example.preview",
    capabilityStatus: "test_only",
    title: "Preview the destination",
    description: "Shows what would be sent.",
  };
  const readiness = getWorkflowReadiness({
    workflow: workflowWith([formStep, testOnlyStep]),
    workflowId: null,
    values: {},
    configuredCredentialKeys: new Set(),
  });

  assert.equal(readiness.testReady, true);
  assert.equal(readiness.activationReady, false);
  assert.equal(readiness.attention[0]?.blocksTest, false);
  assert.equal(readiness.attention[0]?.blocksActivation, true);
});

test("connected app remains incomplete until its resource is selected", () => {
  const step: CompiledWorkflow["steps"][number] = {
    id: "send-to-channel",
    type: "connector_action",
    capabilityId: "slack.send_message",
    capabilityStatus: "supported",
    title: "Send the qualified lead to the regional enterprise sales channel",
    description:
      "Posts the result to the team responsible for long-running enterprise opportunities and customer follow-up.",
    inputsRequired: [
      { key: "channelId", label: "Slack channel", type: "text", required: true },
    ],
    config: {
      connector: {
        connectorId: "slack",
        operationKind: "action",
        operationKey: "send_message",
        operationVersion: 1,
        connectionId: "00000000-0000-4000-8000-000000000002",
        mappings: [],
      },
    },
  };
  const missing = getWorkflowReadiness({
    workflow: workflowWith([formStep, step]),
    workflowId: "00000000-0000-4000-8000-000000000001",
    values: {},
    configuredCredentialKeys: new Set(),
  });
  assert.deepEqual(missing.attention.map((item) => item.actionLabel), ["Choose Slack channel"]);
  assert.equal(missing.testReady, false);

  const resolved = getWorkflowReadiness({
    workflow: workflowWith([formStep, step]),
    workflowId: "00000000-0000-4000-8000-000000000001",
    values: {
      "send-to-channel-channelId":
        "regional-enterprise-sales-and-customer-success-handoffs",
    },
    configuredCredentialKeys: new Set(),
  });
  assert.equal(resolved.testReady, true);
  assert.equal(resolved.activationReady, true);
  assert.deepEqual(resolved.attention, []);
});

test("long workflows stay truthful and count every real step", () => {
  const steps = Array.from({ length: 8 }, (_, index) => ({
    ...storeStep,
    id: `step-${index + 1}`,
    title: `Complete customer action ${index + 1}`,
  }));
  const readiness = getWorkflowReadiness({
    workflow: workflowWith(steps),
    workflowId: null,
    values: {},
    configuredCredentialKeys: new Set(),
  });

  assert.equal(readiness.totalSteps, 8);
  assert.equal(readiness.readySteps, 8);
  assert.equal(readiness.testReady, true);
});

test("workflow UI presents one setup, test, and activation journey", async () => {
  const [workspace, journey] = await Promise.all([
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/workflow-journey-panel.tsx", "utf8"),
  ]);

  assert.match(workspace, /What do you want CrazyLoops to do\?/);
  assert.match(workspace, /Current workflow/);
  assert.match(workspace, /Describe a change, like/);
  assert.match(workspace, /How should CrazyLoops apply this change\?/);
  assert.match(workspace, /current workflow is still running/);
  assert.match(workspace, /Unpublished changes/);
  assert.doesNotMatch(workspace, /pauseForChanges|will turn it off first/);
  assert.doesNotMatch(workspace, /Describe a different automation to replace this one/);
  assert.doesNotMatch(workspace, /create a new version/);

  for (const copy of [
    "Needs your attention",
    "Ready to test",
    "Testing your workflow…",
    "Test successful",
    "Test stopped",
    "Review failed step",
    "Turn on workflow",
    "Publish changes",
    "Active — this workflow is running",
    "View in Activity",
  ]) {
    assert.match(journey, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(journey, /aria-live="polite"/);
  assert.match(journey, /disabled=\{!readiness\.testReady \|\| isTesting\}/);
  assert.match(journey, /disabled=\{!readiness\.activationReady\}/);
  assert.doesNotMatch(journey, /stack trace|execution_id|provider_status|raw JSON/i);
});
