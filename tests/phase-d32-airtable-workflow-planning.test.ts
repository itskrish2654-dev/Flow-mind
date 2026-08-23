import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITY_REGISTRY,
  assessCapability,
  pinWorkflowExecutorSelections,
} from "../lib/capability-registry";
import {
  AirtableWorkflowConfigurationError,
  buildAirtableCreateRecordInput,
  isDeferredCustomerAirtableConnection,
  parseAirtableFieldMappings,
  validateAirtableDestinationIdentifiers,
} from "../lib/connectors/airtable/workflow-configuration";
import {
  connectorConnectionIds,
  matchesOwnedConnectorConnection,
} from "../lib/connectors/connection-matching";
import { getConnector } from "../lib/connectors/registry";
import {
  createDelegatedCredentialResolver,
  DelegatedCredentialError,
} from "../lib/executors/delegated-credentials";
import type { CapabilityExecutionRequest } from "../lib/executors/types";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";
const WORKFLOW_ID = "40000000-0000-4000-8000-000000000004";
const VERSION_ID = "50000000-0000-4000-8000-000000000005";
const EXECUTION_ID = "60000000-0000-4000-8000-000000000006";
const PAT = "patD32SyntheticCredentialNeverSentToClient";
const BASE_ID = "app12345678901234";
const TABLE_ID = "tbl12345678901234";

function plan(prompt: string) {
  return planWorkflow(prompt);
}

function compiledAirtableWorkflow() {
  const result = plan("When a form is submitted, create a record in Airtable.");
  assert.equal(result.status, "READY_TO_COMPILE");
  const workflow = compileReadyPlan("When a form is submitted, create a record in Airtable.", result);
  const step = workflow.steps.find((item) => item.capabilityId === "airtable.create_record");
  assert.ok(step);
  return { workflow, step };
}

function selectAirtableConnection(
  workflow: ReturnType<typeof compiledAirtableWorkflow>["workflow"],
  stepId: string,
) {
  return workflow.steps.map((item) => {
    if (item.id !== stepId) return item;
    const connector = item.config?.connector;
    assert.ok(connector);
    return {
      ...item,
      config: { ...item.config, connector: { ...connector, connectionId: CONNECTION_ID } },
    };
  });
}

function deferredConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    user_id: USER_A,
    connector_id: "airtable",
    provider_family: "airtable",
    auth_type: "api_key" as const,
    status: "connected" as const,
    granted_scopes: [],
    safe_metadata: {
      connectionMode: "customer_api_key",
      providerVerification: "deferred",
    },
    ...overrides,
  };
}

function manifest(connectorId: string) {
  const connector = getConnector(connectorId);
  assert.ok(connector);
  return connector.manifest;
}

test("D3.2 planner recognizes create-record wording", () => {
  const result = plan("When a form is submitted, create a record in Airtable.");
  assert.equal(result.status, "READY_TO_COMPILE");
  assert.equal(result.destination?.capabilityId, "airtable.create_record");
});

test("D3.2 planner recognizes save-form-submissions wording", () => {
  const result = plan("Save form submissions to Airtable.");
  assert.equal(result.status, "READY_TO_COMPILE");
  assert.equal(result.destination?.capabilityId, "airtable.create_record");
});

test("D3.2 planner recognizes send-lead wording without inventing a trigger", () => {
  const result = plan("Send the lead to Airtable.");
  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.equal(result.destination?.capabilityId, "airtable.create_record");
  assert.ok(result.missingRequirements.includes("trigger"));
});

test("D3.2 planner does not fall back to generic HTTP for Airtable create", () => {
  const result = plan("When a form is submitted, create a record in Airtable.");
  assert.notEqual(result.destination?.capabilityId, "generic_http_action");
  assert.notEqual(result.destination?.capabilityId, "http.request");
});

test("D3.2 compiler emits a connector action", () => {
  const { step } = compiledAirtableWorkflow();
  assert.equal(step.type, "connector_action");
  assert.equal(step.capabilityId, "airtable.create_record");
});

test("D3.2 compiler pins the exact versioned connector contract", () => {
  const { step } = compiledAirtableWorkflow();
  assert.deepEqual(step.config?.connector, {
    connectorId: "airtable",
    operationKind: "action",
    operationKey: "create_record",
    operationVersion: 1,
    mappings: [],
  });
});

test("D3.2 compiler never selects a connection implicitly", () => {
  const { step } = compiledAirtableWorkflow();
  assert.equal(step.config?.connector?.connectionId, undefined);
});

test("D3.2 compiler exposes only base, table, and field-mapping setup", () => {
  const { step } = compiledAirtableWorkflow();
  assert.deepEqual(step.inputsRequired?.map((input) => input.key), ["baseId", "tableId", "fields"]);
  assert.equal(step.inputsRequired?.some((input) => /token|secret|credential|pat/i.test(input.key)), false);
});

test("D3.2 compiler pins connector_runner v1", () => {
  const { workflow } = compiledAirtableWorkflow();
  const pinned = pinWorkflowExecutorSelections(workflow).steps.find((step) => step.capabilityId === "airtable.create_record");
  assert.deepEqual(pinned?.executor, { kind: "connector_runner", capabilityVersion: 1 });
});

test("D3.2 validates an exact Airtable base and table ID", () => {
  assert.deepEqual(validateAirtableDestinationIdentifiers(BASE_ID, TABLE_ID), { baseId: BASE_ID, tableId: TABLE_ID });
});

test("D3.2 rejects malformed Airtable base IDs", () => {
  assert.throws(() => validateAirtableDestinationIdentifiers("base123", TABLE_ID), AirtableWorkflowConfigurationError);
});

test("D3.2 rejects malformed Airtable table IDs", () => {
  assert.throws(() => validateAirtableDestinationIdentifiers(BASE_ID, "table123"), AirtableWorkflowConfigurationError);
});

test("D3.2 accepts bounded field-name to workflow-path mappings", () => {
  assert.deepEqual({ ...parseAirtableFieldMappings('{"Name":"name","Email":"trigger.email"}') }, { Name: "name", Email: "trigger.email" });
});

test("D3.2 rejects malformed field mapping JSON", () => {
  assert.throws(() => parseAirtableFieldMappings("{oops"), AirtableWorkflowConfigurationError);
});

test("D3.2 rejects empty field mappings", () => {
  assert.throws(() => parseAirtableFieldMappings("{}"), AirtableWorkflowConfigurationError);
});

test("D3.2 rejects more than 100 field mappings", () => {
  const mappings = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`Field ${index}`, "name"]));
  assert.throws(() => parseAirtableFieldMappings(JSON.stringify(mappings)), AirtableWorkflowConfigurationError);
});

test("D3.2 rejects prototype-pollution source paths", () => {
  assert.throws(() => parseAirtableFieldMappings('{"Name":"constructor.value"}'), AirtableWorkflowConfigurationError);
});

test("D3.2 rejects credential-shaped mapping values", () => {
  assert.throws(() => parseAirtableFieldMappings('{"Name":"patD32CredentialValueThatMustFail"}'), AirtableWorkflowConfigurationError);
  assert.throws(() => parseAirtableFieldMappings('{"Name":"access_token"}'), AirtableWorkflowConfigurationError);
});

test("D3.2 resolves workflow values into the exact runner input", () => {
  assert.deepEqual(buildAirtableCreateRecordInput({
    baseId: BASE_ID,
    tableId: TABLE_ID,
    fieldMappings: '{"Name":"name","Score":"score"}',
    workflowValues: { name: "Ada", score: 7 },
  }), { baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "Ada", Score: 7 } });
});

test("D3.2 fails closed when a mapped workflow value is missing", () => {
  assert.throws(() => buildAirtableCreateRecordInput({
    baseId: BASE_ID,
    tableId: TABLE_ID,
    fieldMappings: '{"Name":"missing"}',
    workflowValues: {},
  }), AirtableWorkflowConfigurationError);
});

test("D3.2 capability remains planner-visible after verified LIVE enablement", () => {
  const capability = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(capability.supported, true);
  assert.equal(capability.internalOnly, false);
  assert.equal(capability.plannerVisible, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, true);
  assert.deepEqual(capability.executorVersions, { 1: "connector_runner" });
});

test("D3.2 generic Airtable connection remains unsupported", () => {
  const result = plan("Connect Airtable.");
  assert.equal(result.status, "UNSUPPORTED");
  assert.deepEqual(result.requestedUnsupportedCapabilities.map((item) => item.capabilityId), ["airtable"]);
});

for (const [label, promptText] of [
  ["update", "When a form is submitted, update an Airtable record."],
  ["delete", "When a form is submitted, delete an Airtable record."],
  ["search", "When a form is submitted, search Airtable records."],
  ["base creation", "When a form is submitted, create an Airtable base."],
] as const) {
  test(`D3.2 unsupported Airtable ${label} stays unsupported`, () => {
    const result = plan(promptText);
    assert.equal(result.status, "UNSUPPORTED");
    assert.ok(result.requestedUnsupportedCapabilities.some((item) => item.capabilityId === "airtable"));
  });
}

test("D3.2 capability assessment allows production after D3.4 eligibility gates", () => {
  assert.equal(assessCapability("airtable.create_record", "test").available, true);
  const production = assessCapability("airtable.create_record", "production");
  assert.equal(production.available, true);
  assert.equal(production.status, "supported");
});

test("D3.2 deferred Airtable metadata is exact and non-authoritative", () => {
  assert.equal(isDeferredCustomerAirtableConnection(deferredConnection()), true);
  assert.equal(isDeferredCustomerAirtableConnection(deferredConnection({ granted_scopes: ["data.records:write"] })), false);
  assert.equal(isDeferredCustomerAirtableConnection(deferredConnection({ safe_metadata: { providerVerification: "verified", connectionMode: "customer_api_key" } })), false);
});

test("D3.2 Gmail accepts the canonical owned Google connection row", () => {
  const google = deferredConnection({ connector_id: "google", provider_family: "google", auth_type: "oauth2", granted_scopes: ["gmail.send"] });
  assert.equal(matchesOwnedConnectorConnection({ connection: google, authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("google_gmail") }), true);
  assert.deepEqual(connectorConnectionIds(manifest("google_gmail")), ["google_gmail", "google"]);
});

test("D3.2 Google Sheets accepts the canonical owned Google connection row", () => {
  const google = deferredConnection({ connector_id: "google", provider_family: "google", auth_type: "oauth2", granted_scopes: ["https://www.googleapis.com/auth/drive.file"] });
  assert.equal(matchesOwnedConnectorConnection({ connection: google, authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("google_sheets") }), true);
  assert.deepEqual(connectorConnectionIds(manifest("google_sheets")), ["google_sheets", "google"]);
});

test("D3.2 canonical connection matching rejects a wrong provider family", () => {
  const google = deferredConnection({ connector_id: "google", provider_family: "slack", auth_type: "oauth2" });
  assert.equal(matchesOwnedConnectorConnection({ connection: google, authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("google_gmail") }), false);
});

test("D3.2 canonical connection matching rejects an unrelated connector ID", () => {
  const google = deferredConnection({ connector_id: "notion", provider_family: "google", auth_type: "oauth2" });
  assert.equal(matchesOwnedConnectorConnection({ connection: google, authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("google_gmail") }), false);
});

test("D3.2 Airtable connection matching remains exact", () => {
  assert.deepEqual(connectorConnectionIds(manifest("airtable")), ["airtable"]);
  assert.equal(matchesOwnedConnectorConnection({ connection: deferredConnection(), authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("airtable") }), true);
  assert.equal(matchesOwnedConnectorConnection({ connection: deferredConnection({ connector_id: "google" }), authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("airtable") }), false);
});

test("D3.2 Slack and Notion canonical connection rows remain valid", () => {
  const slack = deferredConnection({ connector_id: "slack", provider_family: "slack", auth_type: "oauth2" });
  const notion = deferredConnection({ connector_id: "notion", provider_family: "notion", auth_type: "oauth2" });
  assert.equal(matchesOwnedConnectorConnection({ connection: slack, authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("slack") }), true);
  assert.equal(matchesOwnedConnectorConnection({ connection: notion, authenticatedUserId: USER_A, connectionId: CONNECTION_ID, manifest: manifest("notion") }), true);
});

test("D3.2 canonical connection matching rejects cross-user rows", () => {
  assert.equal(matchesOwnedConnectorConnection({ connection: deferredConnection(), authenticatedUserId: USER_B, connectionId: CONNECTION_ID, manifest: manifest("airtable") }), false);
});

test("D3.2 deferred TEST credential resolution uses the exact owned Airtable vault entry", async () => {
  const calls: string[] = [];
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async ({ userId, connectionId }) => {
      calls.push(`load:${userId}:${connectionId}`);
      return deferredConnection();
    },
    readCredential: async ({ userId, connectionId, credentialKey }) => {
      calls.push(`vault:${userId}:${connectionId}:${credentialKey}`);
      return { credentialType: "api_key", plaintext: PAT };
    },
  });
  const result = await resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
    executionMode: "TEST",
  });
  assert.deepEqual(result, { kind: "api_key", value: PAT });
  assert.deepEqual(calls, [`load:${USER_A}:${CONNECTION_ID}`, `vault:${USER_A}:${CONNECTION_ID}:api_key`]);
});

test("D3.2 deferred scope exception never applies to LIVE execution", async () => {
  let vaultReads = 0;
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async () => deferredConnection(),
    readCredential: async () => { vaultReads += 1; return { credentialType: "api_key", plaintext: PAT }; },
  });
  await assert.rejects(resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
    executionMode: "LIVE",
  }), (error: unknown) => error instanceof DelegatedCredentialError && error.category === "DELEGATED_CREDENTIAL_SCOPE_MISSING");
  assert.equal(vaultReads, 0);
});

test("D3.2 cross-account delegated execution is rejected before connection or vault access", async () => {
  let databaseCalls = 0;
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async () => { databaseCalls += 1; return deferredConnection(); },
    readCredential: async () => { databaseCalls += 1; return { credentialType: "api_key", plaintext: PAT }; },
  });
  await assert.rejects(resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_B,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
    executionMode: "TEST",
  }), DelegatedCredentialError);
  assert.equal(databaseCalls, 0);
});

test("D3.2 workflow TEST sends one sanitized runner request and records acknowledgement", async () => {
  const { workflow, step } = compiledAirtableWorkflow();
  const configuredSteps = selectAirtableConnection(workflow, step.id);
  const requests: CapabilityExecutionRequest[] = [];
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps: configuredSteps,
    inputValues: {
      name: "Ada",
      [`${step.id}-baseId`]: BASE_ID,
      [`${step.id}-tableId`]: TABLE_ID,
      [`${step.id}-fields`]: '{"Name":"name"}',
    },
    mode: "test",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute(request) {
        requests.push(request);
        return { ok: true, acknowledged: true, output: { recordId: "rec12345678901234" } };
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].envelope.capabilityId, "airtable.create_record");
  assert.equal(requests[0].envelope.mode, "TEST");
  assert.deepEqual(requests[0].credentialReference, { connectionId: CONNECTION_ID, connectorId: "airtable" });
  assert.deepEqual(requests[0].envelope.input, { baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "Ada" } });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.match(result.logs.at(-1)?.message ?? "", /acknowledged by Airtable/);
  assert.doesNotMatch(JSON.stringify({ request: requests[0], result }), new RegExp(PAT));
});

test("D3.2 runner failure is truthful, not delivered, and not retried automatically", async () => {
  const { workflow, step } = compiledAirtableWorkflow();
  const configuredSteps = selectAirtableConnection(workflow, step.id);
  let calls = 0;
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps: configuredSteps,
    inputValues: { name: "Ada", [`${step.id}-baseId`]: BASE_ID, [`${step.id}-tableId`]: TABLE_ID, [`${step.id}-fields`]: '{"Name":"name"}' },
    mode: "test",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute() { calls += 1; return { ok: false, errorCategory: "DELEGATED_EXECUTION_FAILED", retryable: false }; },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.equal(result.outputData.steps.some((item) => item.status === "succeeded" && item.capabilityId === "airtable.create_record"), false);
});

for (const errorCategory of ["DELEGATED_TIMEOUT", "DELEGATED_UNAVAILABLE"] as const) {
  test(`D3.2 ${errorCategory} Airtable create failure is persisted non-retryable`, async () => {
    const { workflow, step } = compiledAirtableWorkflow();
    let calls = 0;
    let persistedRetryable: boolean | undefined;
    const result = await executeWorkflowSteps({
      userId: USER_A,
      workflowOwnerId: USER_A,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      telemetryExecutionId: EXECUTION_ID,
      workflowName: workflow.workflowName,
      steps: selectAirtableConnection(workflow, step.id),
      inputValues: { name: "Ada", [`${step.id}-baseId`]: BASE_ID, [`${step.id}-tableId`]: TABLE_ID, [`${step.id}-fields`]: '{"Name":"name"}' },
      mode: "test",
      delegatedExecutor: {
        kind: "connector_runner",
        async execute() { calls += 1; return { ok: false, errorCategory, retryable: true }; },
      },
      stateHooks: {
        async onStepFinish(finishedStep, state) {
          if (finishedStep.id === step.id) persistedRetryable = state.retryable;
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(persistedRetryable, false);
    assert.equal(result.outputData.steps.some((item) => item.capabilityId === "airtable.create_record" && item.status === "succeeded"), false);
  });
}

test("D3.2 non-Airtable delegated failure retains its established retryable state", async () => {
  let calls = 0;
  let persistedRetryable: boolean | undefined;
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: "Internal canary",
    steps: [{
      id: "canary",
      type: "connector_action",
      capabilityId: "internal.connector_runner_canary",
      title: "Canary",
      description: "Internal canary",
      executor: { kind: "connector_runner", capabilityVersion: 1 },
    }],
    inputValues: {},
    mode: "test",
    allowInternalCapabilities: true,
    delegatedExecutor: {
      kind: "connector_runner",
      async execute() { calls += 1; return { ok: false, errorCategory: "DELEGATED_TIMEOUT", retryable: true }; },
    },
    stateHooks: { async onStepFinish(_step, state) { persistedRetryable = state.retryable; } },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.equal(persistedRetryable, true);
});

test("D3.2 invalid Airtable setup is rejected before delegated credential/provider work", async () => {
  const { workflow, step } = compiledAirtableWorkflow();
  let calls = 0;
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps: selectAirtableConnection(workflow, step.id),
    inputValues: { name: "Ada", [`${step.id}-baseId`]: "invalid", [`${step.id}-tableId`]: TABLE_ID, [`${step.id}-fields`]: '{"Name":"name"}' },
    mode: "test",
    delegatedExecutor: { kind: "connector_runner", async execute() { calls += 1; return { ok: true, acknowledged: true, output: {} }; } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.equal(calls, 0);
});

test("D3.2 production runtime invokes the runner after D3.4 registry enablement", async () => {
  const { workflow, step } = compiledAirtableWorkflow();
  let calls = 0;
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps: selectAirtableConnection(workflow, step.id),
    inputValues: { name: "Ada", [`${step.id}-baseId`]: BASE_ID, [`${step.id}-tableId`]: TABLE_ID, [`${step.id}-fields`]: '{"Name":"name"}' },
    mode: "public-form",
    delegatedExecutor: { kind: "connector_runner", async execute() { calls += 1; return { ok: true, acknowledged: true, output: { recordId: "rec12345678901234" } }; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(calls, 1);
});

test("D3.2 connection actions remain authenticated, owner-scoped, exact-provider scoped, and secret-free", async () => {
  const [action, component] = await Promise.all([
    readFile("app/actions/connections.ts", "utf8"),
    readFile("components/automation-workspace.tsx", "utf8"),
  ]);
  assert.match(action, /z\.enum\(\["airtable", "google", "slack", "notion"\]\)/);
  assert.match(action, /\.eq\("user_id", user\.id\)/);
  assert.match(action, /\.in\("connector_id", connectorConnectionIds\(registered\.connector\.manifest\)\)/);
  assert.match(action, /matchesOwnedConnectorConnection/);
  assert.match(action, /isDeferredCustomerAirtableConnection\(connection\)/);
  assert.doesNotMatch(component, /airtable[^\n]{0,80}(?:personalAccessToken|plaintext|api[_-]?key)/i);
});
