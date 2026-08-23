import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITY_REGISTRY,
  assessCapability,
} from "../lib/capability-registry";
import {
  AIRTABLE_CREATE_RECORD_SCOPE,
  isDeferredCustomerAirtableConnection,
  isVerifiedCustomerAirtableCreateRecordConnection,
} from "../lib/connectors/airtable/workflow-configuration";
import { matchesOwnedConnectorConnection } from "../lib/connectors/connection-matching";
import { getConnector, listCustomerConnectors } from "../lib/connectors/registry";
import { ConnectorRunnerExecutor } from "../lib/executors/connector-runner";
import {
  createDelegatedCredentialResolver,
  DelegatedCredentialError,
} from "../lib/executors/delegated-credentials";
import type { CapabilityExecutionRequest } from "../lib/executors/types";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";
const WORKFLOW_ID = "40000000-0000-4000-8000-000000000004";
const VERSION_ID = "50000000-0000-4000-8000-000000000005";
const EXECUTION_ID = "60000000-0000-4000-8000-000000000006";
const BASE_ID = "app12345678901234";
const TABLE_ID = "tbl12345678901234";
const RECORD_ID = "rec12345678901234";
const SYNTHETIC_PAT = "patD34MustRemainInsideTheEncryptedVault";

type AirtableConnection = {
  id: string;
  user_id: string;
  connector_id: string;
  provider_family: string;
  auth_type: "none" | "api_key" | "oauth2";
  status: "connected" | "expired" | "revoked" | "error";
  granted_scopes: string[];
  safe_metadata: Record<string, string>;
};

function verifiedConnection(overrides: Partial<AirtableConnection> = {}): AirtableConnection {
  return {
    id: CONNECTION_ID,
    user_id: USER_A,
    connector_id: "airtable",
    provider_family: "airtable",
    auth_type: "api_key",
    status: "connected",
    granted_scopes: [AIRTABLE_CREATE_RECORD_SCOPE],
    safe_metadata: {
      connectionMode: "customer_api_key",
      providerVerification: "operation_verified",
      verifiedOperation: "airtable.create_record",
      verifiedAt: "2026-08-23T00:00:00.000Z",
    },
    ...overrides,
  };
}

function deferredConnection(overrides: Partial<AirtableConnection> = {}): AirtableConnection {
  return verifiedConnection({
    granted_scopes: [],
    safe_metadata: {
      connectionMode: "customer_api_key",
      providerVerification: "deferred",
    },
    ...overrides,
  });
}

const airtableStep = {
  id: "step_2",
  type: "connector_action" as const,
  capabilityId: "airtable.create_record",
  title: "Create Airtable record",
  description: "Create one record",
  executor: { kind: "connector_runner" as const, capabilityVersion: 1 },
  config: {
    connector: {
      connectorId: "airtable",
      operationKind: "action" as const,
      operationKey: "create_record",
      operationVersion: 1,
      connectionId: CONNECTION_ID,
      mappings: [],
    },
  },
};

const setupConfig = {
  "step_2-baseId": BASE_ID,
  "step_2-tableId": TABLE_ID,
  "step_2-fields": '{"Name":"name"}',
};

async function readiness(
  connection: AirtableConnection | null,
  mode: "test" | "production" = "production",
) {
  const connector = getConnector("airtable");
  assert.ok(connector);
  if (!connection || !matchesOwnedConnectorConnection({
    connection,
    authenticatedUserId: USER_A,
    connectionId: CONNECTION_ID,
    manifest: connector.manifest,
  })) return "Reconnect Airtable to continue.";
  if (mode === "test" && isDeferredCustomerAirtableConnection(connection)) return null;
  if (mode === "production" && !isVerifiedCustomerAirtableCreateRecordConnection(connection)) {
    return "This Airtable connection needs a successful test before this loop can be activated.";
  }
  if (!connection.granted_scopes.includes(AIRTABLE_CREATE_RECORD_SCOPE)) {
    return "CrazyLoops needs additional Airtable permission for this workflow.";
  }
  return null;
}

function credentialResolver(connection: AirtableConnection | null) {
  let vaultReads = 0;
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async () => connection,
    readCredential: async () => {
      vaultReads += 1;
      return { credentialType: "api_key", plaintext: SYNTHETIC_PAT };
    },
  });
  return { resolve, vaultReads: () => vaultReads };
}

test("D3.4 capability and connector operation are production enabled", () => {
  const capability = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(capability.supported, true);
  assert.equal(capability.internalOnly, false);
  assert.equal(capability.plannerVisible, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, true);
  assert.deepEqual(capability.executorVersions, { 1: "connector_runner" });
  assert.equal(assessCapability("airtable.create_record", "production").available, true);
  const operation = getConnector("airtable")?.manifest.actions[0];
  assert.equal(operation?.production, true);
  assert.equal(operation?.executor, "connector_runner");
  assert.equal(listCustomerConnectors().some(({ id }) => id === "airtable"), true);
});

test("D3.4 only Airtable becomes a production connector_runner capability", () => {
  const delegated = Object.values(CAPABILITY_REGISTRY)
    .filter((capability) => Object.values(capability.executorVersions ?? {}).includes("connector_runner"))
    .map((capability) => ({
      id: capability.id,
      production: capability.availableInProduction,
      internalOnly: capability.internalOnly,
    }));
  assert.deepEqual(delegated, [
    { id: "internal.connector_runner_canary", production: false, internalOnly: true },
    { id: "airtable.create_record", production: true, internalOnly: false },
  ]);
});

test("D3.4 runner rejects its internal canary in LIVE mode before credential or network access", async () => {
  let credentialReads = 0;
  let networkCalls = 0;
  const result = await new ConnectorRunnerExecutor({
    resolveCredential: async () => { credentialReads += 1; return Buffer.from("never"); },
    fetchImplementation: async () => { networkCalls += 1; return new Response(); },
    captureTelemetry: async () => undefined,
  }).execute({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    envelope: {
      protocolVersion: 1,
      requestId: "70000000-0000-4000-8000-000000000007",
      executionId: EXECUTION_ID,
      workflowVersionId: VERSION_ID,
      stepId: "canary",
      capabilityId: "internal.connector_runner_canary",
      capabilityVersion: 1,
      mode: "LIVE",
      idempotencyKey: "live-canary-must-fail",
      input: {},
    },
  });
  assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_UNSUPPORTED_CAPABILITY", retryable: false });
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
});

test("D3.4 generic and unsupported Airtable operations stay unsupported", () => {
  for (const prompt of [
    "Connect Airtable.",
    "When a form is submitted, update an Airtable record.",
    "When a form is submitted, delete an Airtable record.",
    "When a form is submitted, search Airtable records.",
    "When a form is submitted, create an Airtable base.",
    "When a form is submitted, create an Airtable table.",
  ]) {
    assert.equal(planWorkflow(prompt).status, "UNSUPPORTED", prompt);
  }
  assert.equal(CAPABILITY_REGISTRY.airtable.supported, false);
});

test("D3.4 verified connection is LIVE eligible and deferred connection is not", () => {
  assert.equal(isVerifiedCustomerAirtableCreateRecordConnection(verifiedConnection()), true);
  assert.equal(isVerifiedCustomerAirtableCreateRecordConnection(deferredConnection()), false);
});

test("D3.4 LIVE activation accepts a fully verified Airtable connection", async () => {
  assert.equal(await readiness(verifiedConnection()), null);
});

for (const [label, connection, expected] of [
  ["deferred", deferredConnection(), /successful test/],
  ["missing scope", verifiedConnection({ granted_scopes: [] }), /successful test/],
  ["wrong verification state", verifiedConnection({ safe_metadata: { connectionMode: "customer_api_key", providerVerification: "deferred" } }), /successful test/],
  ["wrong verified operation", verifiedConnection({ safe_metadata: { connectionMode: "customer_api_key", providerVerification: "operation_verified", verifiedOperation: "airtable.update_record" } }), /successful test/],
  ["revoked", verifiedConnection({ status: "revoked" }), /Reconnect Airtable/],
  ["wrong owner", verifiedConnection({ user_id: USER_B }), /Reconnect Airtable/],
  ["wrong provider", verifiedConnection({ provider_family: "notion" }), /Reconnect Airtable/],
  ["wrong connector", verifiedConnection({ connector_id: "notion" }), /Reconnect Airtable/],
  ["wrong auth type", verifiedConnection({ auth_type: "oauth2" }), /successful test/],
] as const) {
  test(`D3.4 LIVE activation rejects ${label}`, async () => {
    assert.match(await readiness(connection) ?? "", expected);
  });
}

test("D3.4 verified and deferred customer connections remain TEST eligible", async () => {
  assert.equal(await readiness(verifiedConnection(), "test"), null);
  assert.equal(await readiness(deferredConnection(), "test"), null);
});

test("D3.4 publication validates readiness before mutating or activating subscriptions", async () => {
  const source = await readFile("app/actions/workflow.ts", "utf8");
  const start = source.indexOf("export async function setWorkflowPublication");
  const end = source.indexOf("export async function getWorkflowConnectorEndpoints", start);
  const publication = source.slice(start, end);
  const readinessIndex = publication.indexOf("validateWorkflowConnectorConnections");
  const mutationIndex = publication.indexOf('.from("workflows")\n    .update');
  const activationIndex = publication.indexOf("activateWorkflowConnectorSubscriptions");
  assert.ok(readinessIndex > -1);
  assert.ok(mutationIndex > readinessIndex);
  assert.ok(activationIndex > mutationIndex);
});

test("D3.4 LIVE credential resolution accepts only exact operation-verified Airtable evidence", async () => {
  const fixture = credentialResolver(verifiedConnection());
  const credential = await fixture.resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
    executionMode: "LIVE",
  });
  assert.deepEqual(credential, { kind: "api_key", value: SYNTHETIC_PAT });
  assert.equal(fixture.vaultReads(), 1);
});

test("D3.4 an operation-verified connection remains eligible for TEST execution", async () => {
  const fixture = credentialResolver(verifiedConnection());
  const credential = await fixture.resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
    executionMode: "TEST",
  });
  assert.deepEqual(credential, { kind: "api_key", value: SYNTHETIC_PAT });
  assert.equal(fixture.vaultReads(), 1);
});

for (const [label, connection] of [
  ["deferred", deferredConnection()],
  ["missing scope", verifiedConnection({ granted_scopes: [] })],
  ["wrong operation", verifiedConnection({ safe_metadata: { connectionMode: "customer_api_key", providerVerification: "operation_verified", verifiedOperation: "airtable.update_record" } })],
  ["revoked", verifiedConnection({ status: "revoked" })],
  ["wrong provider", verifiedConnection({ provider_family: "notion" })],
  ["wrong connector", verifiedConnection({ connector_id: "notion" })],
  ["wrong auth type", verifiedConnection({ auth_type: "oauth2" })],
] as const) {
  test(`D3.4 LIVE credential resolution rejects ${label} before vault access`, async () => {
    const fixture = credentialResolver(connection);
    await assert.rejects(fixture.resolve({
      authenticatedUserId: USER_A,
      workflowOwnerId: USER_A,
      connectionId: CONNECTION_ID,
      connectorId: "airtable",
      capabilityId: "airtable.create_record",
      executionMode: "LIVE",
    }), DelegatedCredentialError);
    assert.equal(fixture.vaultReads(), 0);
  });
}

test("D3.4 cross-user LIVE execution is rejected before connection and vault access", async () => {
  let databaseCalls = 0;
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async () => { databaseCalls += 1; return verifiedConnection(); },
    readCredential: async () => { databaseCalls += 1; return { credentialType: "api_key", plaintext: SYNTHETIC_PAT }; },
  });
  await assert.rejects(resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_B,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
    executionMode: "LIVE",
  }), DelegatedCredentialError);
  assert.equal(databaseCalls, 0);
});

async function liveExecution(result: { ok: true; acknowledged: true; output: Record<string, unknown> } | { ok: false; errorCategory: "DELEGATED_TIMEOUT" | "DELEGATED_UNAVAILABLE"; retryable: true }) {
  const requests: CapabilityExecutionRequest[] = [];
  let persistedRetryable: boolean | undefined;
  let persistedMetadata: Record<string, string | number | boolean | null> | undefined;
  const execution = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: "Airtable LIVE",
    steps: [airtableStep],
    inputValues: { name: "Ada", ...setupConfig },
    mode: "public-form",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute(request) { requests.push(request); return result; },
    },
    stateHooks: {
      async onStepFinish(step, state) {
        if (step.id === airtableStep.id) {
          persistedRetryable = state.retryable;
          persistedMetadata = state.metadata;
        }
      },
    },
  });
  return { execution, requests, persistedRetryable, persistedMetadata };
}

test("D3.4 LIVE mocked create dispatches once and requires a valid Airtable acknowledgement", async () => {
  const { execution, requests, persistedMetadata } = await liveExecution({
    ok: true,
    acknowledged: true,
    output: { recordId: RECORD_ID, ignored: "provider response content" },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].envelope.mode, "LIVE");
  assert.deepEqual(requests[0].credentialReference, { connectionId: CONNECTION_ID, connectorId: "airtable" });
  assert.deepEqual(requests[0].envelope.input, { baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "Ada" } });
  assert.equal(execution.ok, true);
  assert.equal(execution.delivered, true);
  assert.deepEqual(persistedMetadata, { provider: "airtable", operation: "create_record", acknowledged: true, mode: "LIVE" });
  assert.doesNotMatch(JSON.stringify({ execution, requests, persistedMetadata }), new RegExp(SYNTHETIC_PAT));
});

test("D3.4 malformed LIVE success is not delivered", async () => {
  const { execution, requests } = await liveExecution({ ok: true, acknowledged: true, output: { recordId: "invalid" } });
  assert.equal(requests.length, 1);
  assert.equal(execution.ok, false);
  assert.equal(execution.delivered, false);
});

for (const errorCategory of ["DELEGATED_TIMEOUT", "DELEGATED_UNAVAILABLE"] as const) {
  test(`D3.4 ambiguous LIVE ${errorCategory} is non-retryable and not repeated`, async () => {
    const { execution, requests, persistedRetryable } = await liveExecution({ ok: false, errorCategory, retryable: true });
    assert.equal(requests.length, 1);
    assert.equal(execution.ok, false);
    assert.equal(execution.delivered, false);
    assert.equal(persistedRetryable, false);
  });
}

test("D3.4 workflow/setup/log evidence contains no Airtable credential", async () => {
  const evidence = JSON.stringify({ step: airtableStep, setupConfig });
  assert.doesNotMatch(evidence, new RegExp(SYNTHETIC_PAT));
  const [runtime, publication, runner] = await Promise.all([
    readFile("lib/workflow-execution.ts", "utf8"),
    readFile("lib/connectors/subscriptions.ts", "utf8"),
    readFile("lib/executors/connector-runner.ts", "utf8"),
  ]);
  assert.doesNotMatch(`${runtime}\n${publication}`, /personalAccessToken|authorization:\s*Bearer|pat[A-Za-z0-9]{20,}/i);
  assert.match(runner, /credential\?\.fill\(0\)/);
});

test("D3.4 automated acceptance contains no real Airtable HTTP request", async () => {
  const source = await readFile("tests/phase-d34-airtable-production-enablement.test.ts", "utf8");
  assert.doesNotMatch(source, /api\.airtable\.com|fetch\(/);
});
