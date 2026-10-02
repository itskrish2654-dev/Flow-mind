import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITY_REGISTRY,
  assessCapability,
  assessCapabilityVersion,
  getCapability,
  getCapabilityVersion,
  getCapabilityVersionFromDefinition,
  getConnectorCapability,
  getConnectorCapabilityVersion,
  getConnectorOnboarding,
  getCustomerVisibleCapabilities,
  getPlannerVisibleCapabilities,
  resolveStepCapabilityId,
  resolveCapabilityImplementation,
  validateCapabilityDefinitions,
  type CapabilityConnectorOperation,
  type CapabilityConnectorOperationEvidence,
  type CapabilityDefinition,
} from "../lib/capability-registry";
import { validateCapabilityRegistry } from "../lib/capability-registry-validation";
import { getConnectorOperation } from "../lib/connectors/registry";
import { resolveExecutorSelection } from "../lib/executors/router";
import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { planWorkflow, type WorkflowPlan } from "../lib/workflow-planner";
import { getWorkflowReadiness } from "../lib/workflow-readiness";

function cloneCapability(capability: CapabilityDefinition): CapabilityDefinition {
  return structuredClone(capability);
}

function replaceCapability(
  capability: CapabilityDefinition,
  replacement: CapabilityDefinition,
): CapabilityDefinition[] {
  return Object.values(CAPABILITY_REGISTRY).map((candidate) =>
    candidate.id === capability.id ? replacement : candidate,
  );
}

function syntheticConnectorOperation(
  operationVersion: number,
  operationKey = "do_thing",
): CapabilityConnectorOperation {
  return {
    connectorId: "synthetic",
    providerFamily: "synthetic",
    operationKind: "action",
    operationKey,
    operationVersion,
  };
}

function syntheticConnectorEvidence(
  operation: CapabilityConnectorOperation,
): CapabilityConnectorOperationEvidence | null {
  if (operation.connectorId !== "synthetic"
    || operation.providerFamily !== "synthetic"
    || operation.operationKind !== "action"
    || !["do_thing", "other_thing"].includes(operation.operationKey)
    || ![1, 2].includes(operation.operationVersion)) {
    return null;
  }
  return {
    ...operation,
    authType: operation.operationKey === "other_thing" ? "oauth2" : "api_key",
    executor: "connector_runner",
    requiredScopes: ["records:write"],
    connectionRequired: true,
    availableInTest: true,
    availableInProduction: true,
  };
}

function syntheticConnectorEvidenceWithModes(
  availableInTest: boolean,
  availableInProduction: boolean,
) {
  return (operation: CapabilityConnectorOperation): CapabilityConnectorOperationEvidence | null => {
    const evidence = syntheticConnectorEvidence(operation);
    return evidence ? { ...evidence, availableInTest, availableInProduction } : null;
  };
}

function syntheticMultiVersionCapability(): CapabilityDefinition {
  const source = cloneCapability(CAPABILITY_REGISTRY["airtable.create_record"]);
  const versionOneOperation = syntheticConnectorOperation(1);
  const versionTwoOperation = syntheticConnectorOperation(2);
  return {
    ...source,
    id: "synthetic.multi_version",
    displayName: "Synthetic multi-version action",
    executionImplementation: "connector:synthetic/do_thing@1",
    connectorOperation: versionOneOperation,
    providerFamily: "synthetic",
    requiredScopes: ["records:write"],
    aliases: [],
    versions: [
      { version: 1, executor: "connector_runner", connectorOperation: versionOneOperation },
      { version: 2, executor: "connector_runner", connectorOperation: versionTwoOperation },
    ],
    executorVersions: { 1: "connector_runner", 2: "connector_runner" },
    defaultCapabilityVersion: 1,
  };
}

function compiledHubSpotWorkflow(): CompiledWorkflow {
  const prompt = "When I run this workflow, get HubSpot contact 12345.";
  const plan = planWorkflow(prompt);
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") throw new Error("HubSpot plan unavailable.");
  return compileReadyPlan(prompt, plan);
}

test("5D-1 the current CrazyLoops capability registry validates deterministically", () => {
  assert.deepEqual(validateCapabilityRegistry(), []);
  assert.ok(Object.values(CAPABILITY_REGISTRY).every((capability) => capability.versions.length >= 1));
  assert.ok(Object.values(CAPABILITY_REGISTRY).every((capability) =>
    Boolean(getCapabilityVersion(capability.id, capability.defaultCapabilityVersion))));
});

test("5D-2 duplicate capability IDs and invalid default versions fail validation", () => {
  const hubspot = cloneCapability(CAPABILITY_REGISTRY["hubspot.get_contact"]);
  assert.match(
    validateCapabilityRegistry([...Object.values(CAPABILITY_REGISTRY), hubspot]).join(" "),
    /Duplicate capability ID/,
  );

  const versionMismatch = cloneCapability(hubspot);
  versionMismatch.defaultCapabilityVersion = 2;
  assert.match(
    validateCapabilityRegistry(replaceCapability(hubspot, versionMismatch)).join(" "),
    /Default capability version is not registered/,
  );
});

test("5D-2b explicit maturity validates legacy mode flags without being inferred from them", async () => {
  const airtable = cloneCapability(CAPABILITY_REGISTRY["airtable.create_record"]);
  const invalidAvailable = { ...airtable, availableInProduction: false };
  assert.match(
    validateCapabilityRegistry(replaceCapability(airtable, invalidAvailable)).join(" "),
    /AVAILABLE capability is not enabled/,
  );

  const hubspot = cloneCapability(CAPABILITY_REGISTRY["hubspot.get_contact"]);
  assert.match(
    validateCapabilityRegistry(replaceCapability(hubspot, {
      ...hubspot,
      availableInProduction: true,
    })).join(" "),
    /TEST_ONLY capability has invalid mode availability/,
  );

  const reviewed = cloneCapability(CAPABILITY_REGISTRY.slack_send_channel_message);
  const invalidReviewed = { ...reviewed, supported: true };
  assert.match(
    validateCapabilityRegistry(replaceCapability(reviewed, invalidReviewed)).join(" "),
    /Non-executable maturity exposes an execution mode/,
  );
  const legacyFlagsOnly = {
    ...reviewed,
    supported: true,
    availableInTest: true,
    availableInProduction: true,
  };
  assert.equal(legacyFlagsOnly.maturity, "REVIEWED");
  assert.match(
    validateCapabilityRegistry(replaceCapability(reviewed, legacyFlagsOnly)).join(" "),
    /Non-executable maturity exposes an execution mode/,
  );

  for (const id of ["salesforce", "slack_send_channel_message", "formatter.scripting"] as const) {
    const capability = cloneCapability(CAPABILITY_REGISTRY[id]);
    const invalidNonExecutable = {
      ...capability,
      availableInTest: true,
      customerVisible: true,
    };
    assert.match(
      validateCapabilityRegistry(replaceCapability(capability, invalidNonExecutable)).join(" "),
      /Non-executable maturity exposes an execution mode/,
      id,
    );
  }

  const registrySource = await readFile("lib/capability-registry.ts", "utf8");
  assert.doesNotMatch(registrySource, /inferredMaturity/);
});

test("5D-2c invalid visibility, credentials, and onboarding fail closed", () => {
  const airtable = cloneCapability(CAPABILITY_REGISTRY["airtable.create_record"]);

  const internal = cloneCapability(CAPABILITY_REGISTRY["internal.connector_runner_canary"]);
  const exposedInternal = { ...internal, customerVisible: true };
  assert.match(
    validateCapabilityRegistry(replaceCapability(internal, exposedInternal)).join(" "),
    /Internal capability is customer visible/,
  );

  const missingCredentials = { ...airtable, credentialsRequired: false };
  assert.match(
    validateCapabilityRegistry(replaceCapability(airtable, missingCredentials)).join(" "),
    /does not require credentials/,
  );

  const hubspot = cloneCapability(CAPABILITY_REGISTRY["hubspot.get_contact"]);
  const invalidOnboarding = {
    ...hubspot,
    onboarding: { available: true, method: "api_key" as const },
  };
  assert.match(
    validateCapabilityRegistry(replaceCapability(hubspot, invalidOnboarding)).join(" "),
    /Invalid onboarding (method|availability)/,
  );
});

test("5D-2d product availability is a strict subset of technical connector support", () => {
  const reviewed = syntheticMultiVersionCapability();
  Object.assign(reviewed, {
    maturity: "REVIEWED" as const,
    supported: false,
    availableInTest: false,
    availableInProduction: false,
    onboarding: { available: false, method: "api_key" as const },
    plannerVisible: false,
    builderVisible: false,
    connectionVisible: false,
    customerVisible: false,
  });
  assert.deepEqual(
    validateCapabilityDefinitions(
      [reviewed],
      syntheticConnectorEvidenceWithModes(true, true),
    ),
    [],
  );
  assert.equal(reviewed.maturity, "REVIEWED");
  assert.equal(reviewed.availableInTest, false);
  assert.equal(reviewed.availableInProduction, false);

  const productTest = syntheticMultiVersionCapability();
  productTest.maturity = "TEST_ONLY";
  productTest.availableInProduction = false;
  assert.match(
    validateCapabilityDefinitions(
      [productTest],
      syntheticConnectorEvidenceWithModes(false, true),
    ).join(" "),
    /TEST availability exceeds connector support/,
  );

  const productLive = syntheticMultiVersionCapability();
  assert.match(
    validateCapabilityDefinitions(
      [productLive],
      syntheticConnectorEvidenceWithModes(true, false),
    ).join(" "),
    /LIVE availability exceeds connector support/,
  );
});

test("5D-3 maturity and mode availability remain truthful", () => {
  const hubspot = CAPABILITY_REGISTRY["hubspot.get_contact"];
  const airtable = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(hubspot.maturity, "TEST_ONLY");
  assert.equal(assessCapability("hubspot.get_contact", "test").available, true);
  assert.equal(assessCapability("hubspot.get_contact", "production").available, false);
  assert.equal(airtable.maturity, "AVAILABLE");
  assert.equal(assessCapability("airtable.create_record", "production").available, true);
  assert.equal(CAPABILITY_REGISTRY.gmail_send_email.maturity, "AVAILABLE");
  assert.equal(CAPABILITY_REGISTRY.google_sheets_add_row.maturity, "AVAILABLE");
  assert.equal(CAPABILITY_REGISTRY.slack_send_channel_message.maturity, "REVIEWED");
  assert.equal(CAPABILITY_REGISTRY.notion_create_page.maturity, "REVIEWED");
  assert.equal(CAPABILITY_REGISTRY["internal.connector_runner_canary"].maturity, "TEST_ONLY");
  assert.equal(CAPABILITY_REGISTRY["internal.connector_runner_canary"].internalOnly, true);
  assert.equal(assessCapability("gmail_send_email", "test").available, true);
  assert.equal(assessCapability("google_sheets_add_row", "production").available, true);
  assert.equal(CAPABILITY_REGISTRY.google_sheets_add_row.plannerVisible, false);
  assert.equal(CAPABILITY_REGISTRY.google_sheets_add_row.builderVisible, false);
  assert.equal(assessCapability("slack_send_channel_message", "test").available, false);
  assert.equal(assessCapability("notion_create_page", "production").available, false);
  assert.equal(assessCapability("unknown.capability", "test").available, false);
});

test("5D-4 capability versions are exact and never fall forward", () => {
  const implementation = resolveCapabilityImplementation("hubspot.get_contact", 1);
  assert.equal(implementation?.version.executor, "connector_runner");
  assert.equal(implementation?.version.connectorOperation?.operationKey, "get_contact");
  assert.equal(resolveCapabilityImplementation("hubspot.get_contact", 2), null);
  assert.equal(assessCapabilityVersion("hubspot.get_contact", 2, "test").available, false);
  assert.match(assessCapabilityVersion("hubspot.get_contact", 2, "test").message ?? "", /version 2/i);
});

test("5D-4b every capability version owns its exact connector operation", () => {
  const capability = syntheticMultiVersionCapability();
  assert.deepEqual(validateCapabilityDefinitions([capability], syntheticConnectorEvidence), []);

  const versionOne = getCapabilityVersionFromDefinition(capability, 1);
  const versionTwo = getCapabilityVersionFromDefinition(capability, 2);
  assert.equal(versionOne?.connectorOperation?.operationVersion, 1);
  assert.equal(versionTwo?.connectorOperation?.operationVersion, 2);
  assert.equal(getCapabilityVersionFromDefinition(capability, 3), null);
  assert.equal(capability.connectorOperation?.operationVersion, 1);

  const reverseOne = getConnectorCapabilityVersion(
    "synthetic", "action", "do_thing", 1, [capability],
  );
  const reverseTwo = getConnectorCapabilityVersion(
    "synthetic", "action", "do_thing", 2, [capability],
  );
  assert.equal(reverseOne?.capability.id, capability.id);
  assert.equal(reverseOne?.version.version, 1);
  assert.equal(reverseTwo?.capability.id, capability.id);
  assert.equal(reverseTwo?.version.version, 2);
  assert.equal(getConnectorCapabilityVersion("synthetic", "action", "do_thing", 3, [capability]), null);
});

test("5D-4c every version fails closed for missing operations, executor drift, and duplicates", () => {
  const capability = syntheticMultiVersionCapability();
  const missingOperation = cloneCapability(capability);
  const versionTwo = missingOperation.versions[1];
  assert.ok(versionTwo.connectorOperation);
  versionTwo.connectorOperation.operationKey = "missing_operation";
  assert.match(
    validateCapabilityDefinitions([missingOperation], syntheticConnectorEvidence).join(" "),
    /Missing connector operation for synthetic\.multi_version@2/,
  );

  const executorMismatch = cloneCapability(capability);
  executorMismatch.versions[1].executor = "native";
  executorMismatch.executorVersions = { 1: "connector_runner", 2: "native" };
  assert.match(
    validateCapabilityDefinitions([executorMismatch], syntheticConnectorEvidence).join(" "),
    /Executor mismatch for synthetic\.multi_version@2/,
  );

  const duplicate = cloneCapability(capability);
  duplicate.versions = [...duplicate.versions, cloneCapability(capability).versions[1]];
  duplicate.executorVersions = { 1: "connector_runner", 2: "connector_runner" };
  assert.match(
    validateCapabilityDefinitions([duplicate], syntheticConnectorEvidence).join(" "),
    /Duplicate capability version: synthetic\.multi_version@2/,
  );
});

test("5D-5 customer, planner, builder, connection, and internal visibility are distinct", () => {
  const plannerIds = getPlannerVisibleCapabilities().map(({ id }) => id);
  const customerIds = getCustomerVisibleCapabilities().map(({ id }) => id);
  assert.ok(plannerIds.includes("hubspot.get_contact"));
  assert.ok(customerIds.includes("hubspot.get_contact"));
  assert.equal(CAPABILITY_REGISTRY["hubspot.get_contact"].builderVisible, true);
  assert.equal(CAPABILITY_REGISTRY["hubspot.get_contact"].connectionVisible, true);
  assert.equal(CAPABILITY_REGISTRY["internal.connector_runner_canary"].customerVisible, false);
  assert.equal(plannerIds.includes("internal.connector_runner_canary"), false);
  assert.equal(customerIds.includes("internal.bridge_echo"), false);
  assert.equal(CAPABILITY_REGISTRY.hubspot.plannerVisible, false);
});

test("5D-6 onboarding availability is separate from execution availability", () => {
  assert.deepEqual(getConnectorOnboarding("hubspot"), { available: false, method: "oauth2" });
  assert.deepEqual(getConnectorOnboarding("airtable"), { available: true, method: "api_key" });
  assert.deepEqual(getConnectorOnboarding("slack"), { available: false, method: "oauth2" });
  assert.deepEqual(getConnectorOnboarding("notion"), { available: false, method: "oauth2" });
  assert.deepEqual(getConnectorOnboarding("google_gmail"), { available: true, method: "oauth2" });
  assert.deepEqual(getConnectorOnboarding("google_sheets"), { available: true, method: "oauth2" });
  assert.equal(CAPABILITY_REGISTRY["hubspot.get_contact"].availableInTest, true);
  assert.equal(CAPABILITY_REGISTRY["hubspot.get_contact"].onboarding.available, false);
});

test("5D-6b onboarding method comes from available capabilities and conflicts fail validation", () => {
  const unavailableOauth = syntheticMultiVersionCapability();
  unavailableOauth.id = "synthetic.unavailable_oauth";
  unavailableOauth.onboarding = { available: false, method: "oauth2" };

  const availableApiKey = syntheticMultiVersionCapability();
  availableApiKey.id = "synthetic.available_api_key";
  assert.deepEqual(
    getConnectorOnboarding("synthetic", [unavailableOauth, availableApiKey]),
    { available: true, method: "api_key" },
  );

  const oauthCapability = syntheticMultiVersionCapability();
  const otherOperation = syntheticConnectorOperation(1, "other_thing");
  oauthCapability.id = "synthetic.oauth_action";
  oauthCapability.executionImplementation = "connector:synthetic/other_thing@1";
  oauthCapability.connectorOperation = otherOperation;
  oauthCapability.versions = [{
    version: 1,
    executor: "connector_runner",
    connectorOperation: otherOperation,
  }];
  oauthCapability.executorVersions = { 1: "connector_runner" };
  oauthCapability.onboarding = { available: true, method: "oauth2" };
  assert.match(
    validateCapabilityDefinitions(
      [syntheticMultiVersionCapability(), oauthCapability],
      syntheticConnectorEvidence,
    ).join(" "),
    /Conflicting onboarding methods for connector: synthetic/,
  );
});

test("5D-7 connector operations and capability implementations resolve one exact authority chain", () => {
  for (const capability of Object.values(CAPABILITY_REGISTRY)) {
    const defaultVersion = getCapabilityVersionFromDefinition(
      capability,
      capability.defaultCapabilityVersion,
    );
    assert.deepEqual(capability.connectorOperation, defaultVersion?.connectorOperation ?? null);
    for (const version of capability.versions) {
      const link = version.connectorOperation;
      if (!link) continue;
      const operation = getConnectorOperation(
        link.connectorId,
        link.operationKind,
        link.operationKey,
        link.operationVersion,
      );
      assert.ok(operation, `${capability.id}@${version.version}`);
      assert.equal(operation.operation.executor ?? "native", version.executor, capability.id);
      assert.ok(!capability.availableInTest || operation.operation.testMode, capability.id);
      assert.ok(!capability.availableInProduction || operation.operation.production, capability.id);
      assert.equal(operation.operation.connectionRequired, capability.connectionRequired, capability.id);
      assert.deepEqual(new Set(operation.operation.requiredScopes), new Set(capability.requiredScopes), capability.id);
      assert.equal(
        getConnectorCapability(link.connectorId, link.operationKind, link.operationKey, link.operationVersion)?.id,
        capability.id,
      );
      const reverse = getConnectorCapabilityVersion(
        link.connectorId,
        link.operationKind,
        link.operationKey,
        link.operationVersion,
      );
      assert.equal(reverse?.capability.id, capability.id);
      assert.equal(reverse?.version.version, version.version);
    }
  }
});

test("5D-8 planner and compiler admit only registry-visible capabilities and derive implementation pins", () => {
  const workflow = compiledHubSpotWorkflow();
  const step = workflow.steps.find(({ capabilityId }) => capabilityId === "hubspot.get_contact");
  const capability = getCapability("hubspot.get_contact");
  assert.ok(step?.config?.connector);
  assert.ok(capability?.connectorOperation);
  assert.deepEqual(step.config.connector, {
    connectorId: capability.connectorOperation.connectorId,
    operationKind: capability.connectorOperation.operationKind,
    operationKey: capability.connectorOperation.operationKey,
    operationVersion: capability.connectorOperation.operationVersion,
    mappings: [],
  });
  assert.deepEqual(step.executor, { kind: "connector_runner", capabilityVersion: 1 });
  assert.deepEqual(resolveExecutorSelection(step, "hubspot.get_contact"), step.executor);

  for (const prompt of [
    "When I run this workflow, create a HubSpot contact.",
    "When I run this workflow, update a HubSpot contact.",
    "When I run this workflow, delete a HubSpot contact.",
    "When I run this workflow, search arbitrary HubSpot objects.",
  ]) {
    assert.equal(planWorkflow(prompt).status, "UNSUPPORTED", prompt);
  }

  const unsafePlan = {
    ...planWorkflow("When I run this workflow, get HubSpot contact 12345."),
    status: "READY_TO_COMPILE",
    destination: { capabilityId: "hubspot", displayName: "HubSpot" },
  } as WorkflowPlan;
  assert.throws(() => compileReadyPlan("Unsafe plan", unsafePlan), /cannot be compiled/);
});

test("5D-8b reviewed Slack and Notion stay out of planner, compiler, readiness, and onboarding", async () => {
  for (const prompt of [
    "When a new message is posted in Slack, summarize it with AI and create a page in Notion.",
    "When I run this manually, send a message to Slack.",
    "When a Notion page is updated, store it in CrazyLoops.",
  ]) {
    assert.equal(planWorkflow(prompt).status, "UNSUPPORTED", prompt);
  }

  const unsafePlan = {
    ...planWorkflow("When I run this workflow, get HubSpot contact 12345."),
    status: "READY_TO_COMPILE",
    destination: { capabilityId: "slack_send_channel_message", displayName: "Slack" },
  } as WorkflowPlan;
  assert.throws(() => compileReadyPlan("Unsafe Slack plan", unsafePlan), /cannot be compiled/);

  const workflow: CompiledWorkflow = {
    workflowName: "Legacy Slack workflow",
    summary: "A previously saved workflow using an unaccepted connector.",
    steps: [{
      id: "send-slack",
      type: "connector_action",
      capabilityId: "slack_send_channel_message",
      executor: { kind: "native", capabilityVersion: 1 },
      title: "Send a Slack message",
      description: "Previously configured Slack delivery.",
      config: {
        connector: {
          connectorId: "slack",
          operationKind: "action",
          operationKey: "send_channel_message",
          operationVersion: 1,
          mappings: [],
        },
      },
    }],
  };
  const readiness = getWorkflowReadiness({
    workflow,
    workflowId: "30000000-0000-4000-8000-000000000003",
    values: {},
    configuredCredentialKeys: new Set(),
    connections: [],
  });
  assert.equal(readiness.testReady, false);
  assert.equal(readiness.activationReady, false);
  assert.ok(readiness.attention.some(({ key, title, description }) =>
    key === "send-slack:unsupported"
      && /not available/i.test(title)
      && /live Slack acceptance is complete/i.test(description)));

  const [startRoute, callbackRoute, oauth] = await Promise.all([
    readFile("app/api/connectors/oauth/[connectorId]/start/route.ts", "utf8"),
    readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8"),
    readFile("lib/connectors/oauth.ts", "utf8"),
  ]);
  for (const source of [startRoute, callbackRoute, oauth]) {
    assert.match(source, /getConnectorOnboarding\([^)]*\)\?\.available/);
  }
});

test("5D-8c beta metadata agrees with reviewed Slack and Notion product maturity", async () => {
  const [connectorRegistry, connectorGuide, homepage] = await Promise.all([
    readFile("lib/connectors/registry.ts", "utf8"),
    readFile("docs/CONNECTORS_SLACK_NOTION.md", "utf8"),
    readFile("app/page.tsx", "utf8"),
  ]);
  for (const capabilityId of [
    "slack_new_channel_message",
    "slack_send_channel_message",
    "slack_reply_in_thread",
    "notion_page_created_or_added",
    "notion_page_updated",
    "notion_create_page",
    "notion_create_data_source_item",
    "notion_find_item",
    "notion_update_item",
  ] as const) {
    const capability = CAPABILITY_REGISTRY[capabilityId];
    assert.equal(capability.maturity, "REVIEWED", capabilityId);
    assert.equal(capability.supported, false, capabilityId);
    assert.equal(capability.availableInTest, false, capabilityId);
    assert.equal(capability.availableInProduction, false, capabilityId);
    assert.equal(capability.customerVisible, false, capabilityId);
  }
  assert.match(connectorRegistry, /Beta until live Slack app acceptance is complete/);
  assert.match(connectorRegistry, /Beta until live Notion public integration acceptance is complete/);
  assert.match(connectorGuide, /remain `BETA` until the live acceptance scenarios are completed/);
  assert.match(homepage, /Live acceptance pending/);
});

test("5D-9 readiness uses registry TEST, LIVE, connection, and onboarding truth", () => {
  const workflow = compiledHubSpotWorkflow();
  const step = workflow.steps.find(({ capabilityId }) => capabilityId === "hubspot.get_contact");
  assert.ok(step?.config?.connector);
  const values = {
    [`${step.id}-contactId`]: "12345",
    [`${step.id}-properties`]: "firstname",
  };
  const missing = getWorkflowReadiness({
    workflow,
    workflowId: "30000000-0000-4000-8000-000000000003",
    values,
    configuredCredentialKeys: new Set(),
    connections: [],
  });
  assert.equal(missing.testReady, false);
  assert.equal(missing.activationReady, false);
  assert.ok(missing.attention.some(({ title, actionLabel }) =>
    /onboarding is unavailable/i.test(title) && actionLabel === "Review connection"));

  const connectionId = "60000000-0000-4000-8000-000000000006";
  step.config.connector.connectionId = connectionId;
  const connected = getWorkflowReadiness({
    workflow,
    workflowId: "30000000-0000-4000-8000-000000000003",
    values,
    configuredCredentialKeys: new Set(),
    connections: [{ id: connectionId, provider: "hubspot", status: "connected" }],
  });
  assert.equal(connected.testReady, true);
  assert.equal(connected.activationReady, false);
  assert.ok(connected.attention.some(({ blocksTest, blocksActivation }) => !blocksTest && blocksActivation));
});

test("5D-10 product UI reads registry maturity and onboarding without exposing secrets", async () => {
  const [workspace, connections, registry] = await Promise.all([
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/connections-list.tsx", "utf8"),
    readFile("lib/capability-registry.ts", "utf8"),
  ]);
  assert.match(workspace, /capability\?\.onboarding\.available/);
  assert.match(workspace, /capability\?\.maturity === "TEST_ONLY"/);
  assert.match(connections, /providerOnboarding\(provider\)\?\.available/);
  assert.doesNotMatch(registry, /client_secret|access_token|refresh_token|credentialCapsule|CONNECTOR_RUNNER_SECRET/);
});

test("5D-11 legacy unsupported steps remain detectable when hidden from customer surfaces", () => {
  const legacyStep: CompiledWorkflow["steps"][number] = {
    id: "legacy-salesforce",
    type: "http_request",
    title: "Send to Salesforce",
    description: "Post a record to Salesforce.",
    config: { endpoint: "https://1.1.1.1/test", method: "POST" },
  };

  assert.equal(CAPABILITY_REGISTRY.salesforce.plannerVisible, false);
  assert.equal(CAPABILITY_REGISTRY.salesforce.intentRecognizable, true);
  assert.equal(resolveStepCapabilityId(legacyStep), "salesforce");
});
