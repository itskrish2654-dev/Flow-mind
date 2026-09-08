import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITY_REGISTRY,
  assessCapability,
} from "../lib/capability-registry";
import {
  buildHubSpotGetContactInput,
  parseHubSpotGetContactOutput,
} from "../lib/connectors/hubspot/get-contact";
import { getConnector, getConnectorOperation } from "../lib/connectors/registry";
import {
  createDelegatedCredentialResolver,
  DelegatedCredentialError,
} from "../lib/executors/delegated-credentials";
import { ConnectorRunnerExecutor } from "../lib/executors/connector-runner";
import {
  createConnectorRunnerBodyDigest,
  createConnectorRunnerCapsuleAdditionalData,
} from "../lib/executors/connector-runner-protocol";
import {
  DelegatedExecutionError,
  type CapabilityExecutionRequest,
} from "../lib/executors/types";
import { classifyExecutionError } from "../lib/execution-reliability";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";
import { openCredentialCapsule } from "../services/connector-runner/src/runner.mjs";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const WORKFLOW_ID = "30000000-0000-4000-8000-000000000003";
const VERSION_ID = "40000000-0000-4000-8000-000000000004";
const EXECUTION_ID = "50000000-0000-4000-8000-000000000005";
const CONNECTION_ID = "60000000-0000-4000-8000-000000000006";
const FIXED_NOW = 1_800_000_000_000;
const TOKEN = `hubspot-test-token-${randomBytes(24).toString("hex")}`;
const TRANSPORT_SECRET = "step5c-transport-secret".padEnd(64, "s");
const WRAP_KEY = randomBytes(32);

function hubSpotConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    user_id: USER_A,
    connector_id: "hubspot",
    provider_family: "hubspot",
    auth_type: "oauth2" as const,
    status: "connected" as const,
    granted_scopes: ["crm.objects.contacts.read"],
    safe_metadata: {},
    ...overrides,
  };
}

function compiledHubSpotWorkflow() {
  const prompt = "When I run this workflow, get HubSpot contact 12345.";
  const plan = planWorkflow(prompt);
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") throw new Error("plan unavailable");
  const workflow = compileReadyPlan(prompt, plan);
  const step = workflow.steps.find((item) => item.capabilityId === "hubspot.get_contact");
  assert.ok(step?.config?.connector);
  return {
    workflow,
    compiledStep: step,
    step: {
      ...step,
      config: {
        ...step.config,
        connector: { ...step.config.connector, connectionId: CONNECTION_ID },
      },
    },
  };
}

function runnerRequest(overrides: Partial<CapabilityExecutionRequest["envelope"]> = {}): CapabilityExecutionRequest {
  return {
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    credentialReference: { connectionId: CONNECTION_ID, connectorId: "hubspot" },
    envelope: {
      protocolVersion: 1,
      requestId: randomUUID(),
      executionId: EXECUTION_ID,
      workflowVersionId: VERSION_ID,
      stepId: "step_2",
      capabilityId: "hubspot.get_contact",
      capabilityVersion: 1,
      mode: "TEST",
      idempotencyKey: `${EXECUTION_ID}:step_2:v1`,
      input: { contactId: "12345", properties: ["firstname", "lastname", "email"] },
      ...overrides,
    },
  };
}

async function withRunnerEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const values = {
    DELEGATED_EXECUTION_ENABLED: "true",
    CONNECTOR_RUNNER_EXECUTION_ENABLED: "true",
    CONNECTOR_RUNNER_URL: "https://runner.example.test/v1/execute",
    CONNECTOR_RUNNER_SECRET: TRANSPORT_SECRET,
    CONNECTOR_RUNNER_TIMEOUT_MS: "1000",
    CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION: "1",
    CONNECTOR_RUNNER_WRAP_KEY_V1: WRAP_KEY.toString("base64"),
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function successResponse(requestId: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    protocolVersion: 1,
    requestId,
    ok: true,
    acknowledged: true,
    output: {
      contactId: "12345",
      properties: { firstname: "Ada", lastname: "Lovelace", email: "ada@example.test" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archived: false,
    },
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("5C-1 registry exposes only the exact HubSpot TEST operation", () => {
  const capability = CAPABILITY_REGISTRY["hubspot.get_contact"];
  assert.equal(capability.supported, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, false);
  assert.equal(capability.internalOnly, false);
  assert.equal(capability.plannerVisible, true);
  assert.deepEqual(capability.executorVersions, { 1: "connector_runner" });
  assert.equal(assessCapability("hubspot.get_contact", "test").available, true);
  assert.equal(assessCapability("hubspot.get_contact", "production").status, "test_only");

  const connector = getConnector("hubspot");
  const operation = getConnectorOperation("hubspot", "action", "get_contact", 1);
  assert.equal(connector?.manifest.status, "INTERNAL");
  assert.equal(operation?.operation.executor, "connector_runner");
  assert.equal(operation?.operation.testMode, true);
  assert.equal(operation?.operation.production, false);
  assert.deepEqual(operation?.operation.requiredScopes, ["crm.objects.contacts.read"]);
  assert.equal(getConnectorOperation("hubspot", "action", "get_contact", 2), null);
  assert.equal(getConnectorOperation("hubspot", "action", "create_contact", 1), null);
});

test("5C-2 planner/compiler build the narrow HubSpot TEST flow and keep generic HubSpot unsupported", () => {
  const { workflow, compiledStep } = compiledHubSpotWorkflow();
  assert.equal(compiledStep.type, "connector_action");
  assert.equal(compiledStep.capabilityStatus, "test_only");
  assert.deepEqual(compiledStep.executor, { kind: "connector_runner", capabilityVersion: 1 });
  assert.deepEqual(compiledStep.config?.connector, {
    connectorId: "hubspot",
    operationKind: "action",
    operationKey: "get_contact",
    operationVersion: 1,
    mappings: [],
  });
  assert.deepEqual(compiledStep.inputsRequired?.map(({ key }) => key), ["contactId", "properties"]);
  assert.doesNotMatch(JSON.stringify(workflow), /https?:\/\/|piecePackage|actionName/);
  assert.equal(planWorkflow("Connect HubSpot.").status, "UNSUPPORTED");
  assert.equal(planWorkflow("When I run this workflow, create a HubSpot contact.").status, "UNSUPPORTED");
});

test("5C-3 input and output are exact, bounded, and provider URLs are not accepted", () => {
  assert.deepEqual(buildHubSpotGetContactInput({
    contactId: "12345",
    properties: "firstname\nlastname,email\nemail",
  }), { contactId: "12345", properties: ["firstname", "lastname", "email"] });
  assert.throws(() => buildHubSpotGetContactInput({ contactId: "https://api.hubapi.com/contact/1", properties: [] }));
  assert.throws(() => buildHubSpotGetContactInput({ contactId: "123", properties: Array.from({ length: 26 }, (_, index) => `property_${index}`) }));
  assert.throws(() => buildHubSpotGetContactInput({ contactId: "123", properties: ["x".repeat(101)] }));
  assert.throws(() => parseHubSpotGetContactOutput({ contactId: "123", properties: {}, archived: false, accessToken: TOKEN }));
  assert.throws(() => parseHubSpotGetContactOutput({ contactId: "123", properties: { notes: "x".repeat(10_001) }, archived: false }));
});

test("5C-4 owned HubSpot connection resolves only its existing vault credential", async () => {
  const calls: string[] = [];
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async ({ userId, connectionId }) => {
      calls.push(`connection:${userId}:${connectionId}`);
      return hubSpotConnection();
    },
    readCredential: async ({ userId, connectionId, credentialKey }) => {
      calls.push(`vault:${userId}:${connectionId}:${credentialKey}`);
      return { credentialType: "oauth_access_token", plaintext: TOKEN };
    },
  });
  assert.deepEqual(await resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "hubspot",
    capabilityId: "hubspot.get_contact",
    executionMode: "TEST",
  }), { kind: "oauth2_bearer", value: TOKEN });
  assert.deepEqual(calls, [
    `connection:${USER_A}:${CONNECTION_ID}`,
    `vault:${USER_A}:${CONNECTION_ID}:access_token`,
  ]);
});

test("5C-5 cross-tenant, scope, and LIVE failures happen before vault decryption", async () => {
  for (const [label, connection, executionMode] of [
    ["cross-tenant", hubSpotConnection({ user_id: USER_B }), "TEST"],
    ["missing-scope", hubSpotConnection({ granted_scopes: [] }), "TEST"],
    ["live", hubSpotConnection(), "LIVE"],
  ] as const) {
    let vaultReads = 0;
    const resolve = createDelegatedCredentialResolver({
      loadOwnedConnection: async () => connection,
      readCredential: async () => {
        vaultReads += 1;
        return { credentialType: "oauth_access_token", plaintext: TOKEN };
      },
    });
    await assert.rejects(resolve({
      authenticatedUserId: USER_A,
      workflowOwnerId: USER_A,
      connectionId: CONNECTION_ID,
      connectorId: "hubspot",
      capabilityId: "hubspot.get_contact",
      executionMode,
    }), (error: unknown) => error instanceof DelegatedCredentialError, label);
    assert.equal(vaultReads, 0, label);
  }
});

test("5C-6 existing workflow Test action sends exactly one authoritative HubSpot request", async () => {
  const { workflow, step } = compiledHubSpotWorkflow();
  const requests: CapabilityExecutionRequest[] = [];
  let persisted: Record<string, unknown> | undefined;
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps: workflow.steps.map((item) => item.id === step.id ? step : item),
    inputValues: {
      [`${step.id}-contactId`]: "12345",
      [`${step.id}-properties`]: "firstname\nlastname\nemail",
      [`${step.id}-providerUrl`]: "https://attacker.invalid",
    },
    mode: "test",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute(request) {
        requests.push(request);
        return {
          ok: true,
          acknowledged: true,
          output: { contactId: "12345", properties: { firstname: "Ada" }, archived: false },
        };
      },
    },
    stateHooks: {
      async onStepFinish(finishedStep, state) {
        if (finishedStep.id === step.id) persisted = state.metadata;
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].envelope.capabilityId, "hubspot.get_contact");
  assert.equal(requests[0].envelope.capabilityVersion, 1);
  assert.equal(requests[0].envelope.mode, "TEST");
  assert.deepEqual(requests[0].credentialReference, { connectionId: CONNECTION_ID, connectorId: "hubspot" });
  assert.deepEqual(requests[0].envelope.input, { contactId: "12345", properties: ["firstname", "lastname", "email"] });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, false);
  assert.match(result.logs.at(-1)?.message ?? "", /Contact retrieved/);
  assert.deepEqual(result.outputData.connector_results[step.id], { contactId: "12345", properties: { firstname: "Ada" }, archived: false });
  assert.deepEqual(persisted, {
    provider: "hubspot",
    operation: "get_contact",
    connectionId: CONNECTION_ID,
    capabilityVersion: 1,
    mode: "TEST",
    acknowledged: true,
  });
  assert.doesNotMatch(JSON.stringify({ requests, result, persisted }), new RegExp(TOKEN));
});

test("5C-7 malformed input and LIVE mode call neither Runner nor provider", async () => {
  const { workflow, step } = compiledHubSpotWorkflow();
  for (const [mode, contactId] of [["test", "not a contact id"], ["public-form", "12345"]] as const) {
    let calls = 0;
    const result = await executeWorkflowSteps({
      userId: USER_A,
      workflowOwnerId: USER_A,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      telemetryExecutionId: EXECUTION_ID,
      workflowName: workflow.workflowName,
      steps: workflow.steps.map((item) => item.id === step.id ? step : item),
      inputValues: { [`${step.id}-contactId`]: contactId, [`${step.id}-properties`]: "firstname" },
      mode,
      delegatedExecutor: {
        kind: "connector_runner",
        async execute() {
          calls += 1;
          return { ok: true, acknowledged: true, output: {} };
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(calls, 0);
  }
});

test("5C-8 normalized delegated failure is safe, exact, persisted, and never retried", async () => {
  const { workflow, step } = compiledHubSpotWorkflow();
  let calls = 0;
  let finished: {
    error?: unknown;
    retryable?: boolean;
    metadata?: Record<string, string | number | boolean | null>;
  } | undefined;
  const result = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps: workflow.steps.map((item) => item.id === step.id ? step : item),
    inputValues: { [`${step.id}-contactId`]: "12345", [`${step.id}-properties`]: "email" },
    mode: "test",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute() {
        calls += 1;
        return { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false };
      },
    },
    stateHooks: {
      async onStepFinish(finishedStep, state) {
        if (finishedStep.id === step.id) finished = state;
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.match(result.failureReason ?? "", /HubSpot authentication failed/);
  assert.equal(finished?.error instanceof DelegatedExecutionError, true);
  assert.equal((finished?.error as DelegatedExecutionError).category, "DELEGATED_AUTH_FAILED");
  assert.equal(finished?.retryable, false);
  assert.equal(finished?.metadata?.errorCategory, "DELEGATED_AUTH_FAILED");
  assert.deepEqual(classifyExecutionError(finished?.error), {
    category: "DELEGATED_AUTH_FAILED",
    retryable: false,
    safeMessage: "This app is temporarily unavailable.",
  });
  assert.doesNotMatch(JSON.stringify({ result, finished }), new RegExp(TOKEN));
});

test("5C-9 product Runner client hashes and sends one exact body with exact-string HMAC", async () => {
  await withRunnerEnvironment(async () => {
    let calls = 0;
    let rawBody = "";
    const request = runnerRequest();
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(TOKEN),
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
      fetchImplementation: async (_url, init) => {
        calls += 1;
        rawBody = String(init?.body ?? "");
        const headers = new Headers(init?.headers);
        const envelope = JSON.parse(rawBody);
        const digest = createHash("sha256").update(rawBody).digest("hex");
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(headers.get("x-crazyloops-content-sha256"), digest);
        assert.equal(headers.get("x-crazyloops-timestamp"), String(FIXED_NOW));
        assert.equal(headers.get("x-crazyloops-request-id"), request.envelope.requestId);
        assert.equal(headers.get("x-crazyloops-signature"), `v1=${createHmac("sha256", TRANSPORT_SECRET).update(`${FIXED_NOW}.${request.envelope.requestId}.${digest}`).digest("hex")}`);
        assert.equal(envelope.credentialCapsule.expiresAt, FIXED_NOW + 60_000);
        assert.equal(Buffer.from(envelope.credentialCapsule.nonce, "base64").length, 12);
        const plaintext = openCredentialCapsule(envelope, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW);
        try { assert.equal(plaintext.toString("utf8"), TOKEN); } finally { plaintext.fill(0); }
        return successResponse(request.envelope.requestId);
      },
    }).execute(request);
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(createConnectorRunnerBodyDigest(rawBody), createHash("sha256").update(rawBody).digest("hex"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  });
});

test("5C-10 accepted capsule AAD binds every authority identifier and rejects changes", async () => {
  await withRunnerEnvironment(async () => {
    let captured: Record<string, unknown> | null = null;
    const request = runnerRequest();
    await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(TOKEN),
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
      fetchImplementation: async (_url, init) => {
        captured = JSON.parse(String(init?.body ?? ""));
        return successResponse(request.envelope.requestId);
      },
    }).execute(request);
    assert.ok(captured);
    const envelope = captured as never as Parameters<typeof openCredentialCapsule>[0];
    const aad = createConnectorRunnerCapsuleAdditionalData({
      binding: envelope,
      keyVersion: envelope.credentialCapsule.keyVersion,
      expiresAt: envelope.credentialCapsule.expiresAt,
    }).toString("utf8");
    assert.equal(aad, JSON.stringify({
      namespace: "crazyloops:connector-runner:credential-capsule:v1",
      protocolVersion: 1,
      requestId: request.envelope.requestId,
      executionId: EXECUTION_ID,
      workflowVersionId: VERSION_ID,
      stepId: "step_2",
      capabilityId: "hubspot.get_contact",
      capabilityVersion: 1,
      keyVersion: 1,
      algorithm: "aes-256-gcm",
      expiresAt: FIXED_NOW + 60_000,
    }));
    assert.throws(() => openCredentialCapsule(envelope, new Map([[1, randomBytes(32)]]), FIXED_NOW));
    for (const key of ["requestId", "executionId", "workflowVersionId", "stepId"] as const) {
      assert.throws(() => openCredentialCapsule({ ...envelope, [key]: randomUUID() }, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW));
    }
    assert.throws(() => openCredentialCapsule(envelope, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW + 60_001));
    const tampered = structuredClone(envelope);
    tampered.credentialCapsule.ciphertext = `${tampered.credentialCapsule.ciphertext[0] === "A" ? "B" : "A"}${tampered.credentialCapsule.ciphertext.slice(1)}`;
    assert.throws(() => openCredentialCapsule(tampered, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW));
  });
});

test("5C-11 Runner response protocol fails closed without retrying", async () => {
  const cases: Array<[string, (requestId: string, signal?: AbortSignal) => Promise<Response>, string]> = [
    ["HTTP 200 failure", async (requestId) => new Response(JSON.stringify({ protocolVersion: 1, requestId, ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false }), { headers: { "Content-Type": "application/json" } }), "DELEGATED_AUTH_FAILED"],
    ["wrong request", async () => successResponse(randomUUID()), "DELEGATED_BAD_RESPONSE"],
    ["malformed JSON", async () => new Response("{", { headers: { "Content-Type": "application/json" } }), "DELEGATED_BAD_RESPONSE"],
    ["unexpected field", async (requestId) => successResponse(requestId, { credentialCapsule: "forbidden" }), "DELEGATED_BAD_RESPONSE"],
    ["oversized", async () => new Response(`{"padding":"${"x".repeat(65 * 1024)}"}`, { headers: { "Content-Type": "application/json" } }), "DELEGATED_BAD_RESPONSE"],
    ["connection", async () => { throw new TypeError("connection failed"); }, "DELEGATED_CONNECTION_FAILED"],
    ["timeout", async (_requestId, signal) => new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })), "DELEGATED_TIMEOUT"],
  ];
  for (const [label, response, category] of cases) {
    await withRunnerEnvironment(async () => {
      let calls = 0;
      const request = runnerRequest();
      const result = await new ConnectorRunnerExecutor({
        resolveCredential: async () => Buffer.from(TOKEN),
        captureTelemetry: async () => undefined,
        now: () => FIXED_NOW,
        fetchImplementation: async (_url, init) => {
          calls += 1;
          return response(request.envelope.requestId, init?.signal ?? undefined);
        },
      }).execute(request);
      assert.equal(calls, 1, label);
      assert.equal(result.ok, false, label);
      if (!result.ok) assert.equal(result.errorCategory, category, label);
    });
  }
});

test("5C-12 arbitrary capability, wrong version, LIVE, and owner mismatch stop before credential or Runner", async () => {
  for (const [label, request] of [
    ["arbitrary", runnerRequest({ capabilityId: "hubspot.create_contact" })],
    ["version", runnerRequest({ capabilityVersion: 2 })],
    ["live", runnerRequest({ mode: "LIVE" })],
    ["invalid-input", runnerRequest({ input: { contactId: "12345", properties: ["email"], providerUrl: "https://attacker.invalid" } })],
    ["owner", { ...runnerRequest(), workflowOwnerId: USER_B }],
  ] as const) {
    let credentialReads = 0;
    let runnerCalls = 0;
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => { credentialReads += 1; return Buffer.from(TOKEN); },
      captureTelemetry: async () => undefined,
      fetchImplementation: async () => { runnerCalls += 1; return new Response(); },
    }).execute(request);
    assert.equal(result.ok, false, label);
    assert.equal(credentialReads, 0, label);
    assert.equal(runnerCalls, 0, label);
  }
});

test("5C-13 server action/history/UI boundaries reuse authoritative saved state and expose no secrets", async () => {
  const [action, versioning, history, workspace, activity, runner, env] = await Promise.all([
    readFile("app/actions/execute.ts", "utf8"),
    readFile("lib/workflow-versioning.ts", "utf8"),
    readFile("lib/execution-state.ts", "utf8"),
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/executions-data-table.tsx", "utf8"),
    readFile("lib/executors/connector-runner.ts", "utf8"),
    readFile(".env.example", "utf8"),
  ]);
  assert.ok(action.indexOf("getAuthenticatedContext()") < action.indexOf("createDurableExecution(admin"));
  assert.match(action, /loadWorkflowSnapshot\(admin, request\.data\.workflowId, auth\.user\.id\)/);
  assert.match(action, /savedWorkflow\.data\.steps/);
  assert.match(versioning, /\.eq\("id", workflowId\)[\s\S]*\.eq\("user_id", userId\)/);
  assert.match(history, /workflow_execution_steps/);
  assert.match(history, /error_category: classification\?\.category/);
  assert.match(workspace, /runTestWorkflow\(/);
  assert.match(workspace, /HubSpot — Get Contact|HubSpot account/);
  assert.match(activity, /connector_results/);
  assert.doesNotMatch(`${workspace}\n${activity}`, /CONNECTOR_RUNNER_SECRET|CONNECTOR_RUNNER_WRAP_KEY|credentialCapsule/);
  assert.doesNotMatch(env, /NEXT_PUBLIC_.*(?:RUNNER|WRAP_KEY|DELEGATED)/);
  assert.doesNotMatch(runner, /console\.(?:log|error)/);
  assert.doesNotMatch(JSON.stringify({ action: "Unauthorized", ui: "Contact retrieved." }), new RegExp(TOKEN));
});
