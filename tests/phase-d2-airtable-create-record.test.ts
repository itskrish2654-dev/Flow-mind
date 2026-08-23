import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import {
  CAPABILITY_REGISTRY,
  assessCapability,
  pinWorkflowExecutorSelections,
} from "../lib/capability-registry";
import { getConnector, listCustomerConnectors } from "../lib/connectors/registry";
import {
  createDelegatedCredentialResolver,
  DelegatedCredentialError,
} from "../lib/executors/delegated-credentials";
import { ConnectorRunnerExecutor } from "../lib/executors/connector-runner";
import {
  createConnectorRunnerBodyDigest,
  createConnectorRunnerCredentialCapsule,
  createConnectorRunnerSignature,
  type ConnectorRunnerCapsuleBinding,
  type ConnectorRunnerRequestEnvelope,
} from "../lib/executors/connector-runner-protocol";
import type { CapabilityExecutionRequest } from "../lib/executors/types";
import { resolveExecutorSelection } from "../lib/executors/router";
import {
  executeAirtableAcceptance,
  handleAirtableAcceptancePost,
} from "../lib/operations/airtable-create-record-acceptance";
import { CompiledWorkflowSchema } from "../lib/schemas/workflow";
import { processRunnerRequest } from "../services/connector-runner/src/runner.mjs";

const FIXED_NOW = 1_800_000_000_000;
const TRANSPORT_SECRET = "d2-runner-transport-secret".padEnd(64, "t");
const WRAP_KEY = randomBytes(32);
const PAT = "patD2CredentialThatMustNeverAppearOutsideTheCapsule";
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";
const BASE_ID = "app12345678901234";
const TABLE_ID = "tbl12345678901234";
const RECORD_ID = "rec12345678901234";

class ReplayStore {
  readonly serializedClaims: string[] = [];
  private readonly claims = new Set<string>();

  async claim(input: { fingerprint: string; ttlMs: number }) {
    this.serializedClaims.push(JSON.stringify(input));
    if (this.claims.has(input.fingerprint)) return false;
    this.claims.add(input.fingerprint);
    return true;
  }
}

function makeEnvelope(input: {
  capabilityId?: string;
  capabilityVersion?: number;
  credential?: string;
  adapterInput?: Record<string, unknown>;
} = {}): ConnectorRunnerRequestEnvelope {
  const binding: ConnectorRunnerCapsuleBinding = {
    protocolVersion: 1,
    requestId: randomUUID(),
    executionId: randomUUID(),
    workflowVersionId: randomUUID(),
    stepId: "airtable_create",
    capabilityId: input.capabilityId ?? "airtable.create_record",
    capabilityVersion: input.capabilityVersion ?? 1,
  };
  const credential = Buffer.from(input.credential ?? PAT, "utf8");
  try {
    return {
      ...binding,
      mode: "TEST",
      idempotencyKey: `${binding.executionId}:${binding.stepId}:v1`,
      input: input.adapterInput ?? {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        fields: { Name: "CrazyLoops D2 acceptance" },
      },
      credentialCapsule: createConnectorRunnerCredentialCapsule({
        credential,
        binding,
        keyVersion: 1,
        wrapKey: WRAP_KEY,
        now: FIXED_NOW,
      }),
    };
  } finally {
    credential.fill(0);
  }
}

function headersFor(envelope: ConnectorRunnerRequestEnvelope) {
  const rawBody = JSON.stringify(envelope);
  const digest = createConnectorRunnerBodyDigest(rawBody);
  return {
    rawBody,
    headers: {
      "x-crazyloops-timestamp": String(FIXED_NOW),
      "x-crazyloops-request-id": envelope.requestId,
      "x-crazyloops-content-sha256": digest,
      "x-crazyloops-signature": `v1=${createConnectorRunnerSignature({
        secret: TRANSPORT_SECRET,
        timestamp: String(FIXED_NOW),
        requestId: envelope.requestId,
        bodyDigest: digest,
      })}`,
    },
  };
}

async function invoke(input: {
  envelope?: ConnectorRunnerRequestEnvelope;
  providerFetch?: typeof fetch;
  replayStore?: ReplayStore | { claim(input: { fingerprint: string; ttlMs: number }): Promise<boolean> };
  logs?: Array<Record<string, unknown>>;
  adapterTimeoutMs?: number;
  adapters?: Map<string, { execute(input: Record<string, unknown>): Promise<Record<string, unknown>> }>;
  keyRing?: Map<number, Buffer>;
} = {}) {
  const envelope = input.envelope ?? makeEnvelope();
  const signed = headersFor(envelope);
  return processRunnerRequest({
    ...signed,
    transportSecret: TRANSPORT_SECRET,
    keyRing: input.keyRing ?? new Map([[1, Buffer.from(WRAP_KEY)]]),
    replayStore: input.replayStore ?? new ReplayStore(),
    now: FIXED_NOW,
    adapterTimeoutMs: input.adapterTimeoutMs ?? 100,
    fetchImplementation: input.providerFetch ?? (async () => new Response(JSON.stringify({
      records: [{ id: RECORD_ID, fields: { ignored: true } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })),
    ...(input.adapters ? { adapters: input.adapters as never } : {}),
    logger: (event: Record<string, unknown>) => { input.logs?.push(event); },
  });
}

function errorCategory(result: Awaited<ReturnType<typeof invoke>>) {
  return (result.body as { errorCategory?: string }).errorCategory;
}

function withRunnerEnvironment<T>(run: () => Promise<T>): Promise<T> {
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
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("D2 runner capability remains versioned and production-disabled while generic Airtable stays unsupported", () => {
  assert.equal(CAPABILITY_REGISTRY.airtable.supported, false);
  const capability = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(capability.internalOnly, false);
  assert.equal(capability.plannerVisible, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, false);
  assert.ok(capability.aliases.includes("create airtable record"));
  assert.equal(capability.executionImplementation, "connector:airtable/create_record@1");
  assert.deepEqual(capability.executorVersions, { 1: "connector_runner" });
  assert.equal(assessCapability("airtable.create_record", "production").available, false);
  assert.equal(listCustomerConnectors().some((item) => item.id === "airtable"), false);
  const operation = getConnector("airtable")?.manifest.actions[0];
  assert.equal(operation?.key, "create_record");
  assert.equal(operation?.executor, "connector_runner");
  assert.deepEqual(operation?.requiredScopes, ["data.records:write"]);
});

test("D2 immutable workflow pinning selects connector_runner v1 and native selection is unchanged", () => {
  const workflow = CompiledWorkflowSchema.parse({
    workflowName: "Internal Airtable acceptance",
    summary: "Internal",
    steps: [{
      id: "create",
      type: "connector_action",
      capabilityId: "airtable.create_record",
      title: "Create Airtable record",
      description: "Internal acceptance",
    }],
  });
  const pinned = pinWorkflowExecutorSelections(workflow);
  assert.deepEqual(pinned.steps[0].executor, { kind: "connector_runner", capabilityVersion: 1 });
  assert.deepEqual(resolveExecutorSelection(pinned.steps[0], "airtable.create_record"), {
    kind: "connector_runner",
    capabilityVersion: 1,
  });
  assert.deepEqual(resolveExecutorSelection({
    id: "store", type: "store_data", title: "Store", description: "Store",
  }, "flowmind_data_store"), { kind: "native", capabilityVersion: 1 });
});

test("D2 resolver uses the owned Airtable API-key vault projection and required scope", async () => {
  const calls: string[] = [];
  const resolve = createDelegatedCredentialResolver({
    loadOwnedConnection: async ({ userId, connectionId }) => {
      calls.push(`load:${userId}:${connectionId}`);
      return {
        id: CONNECTION_ID,
        user_id: USER_A,
        connector_id: "airtable",
        provider_family: "airtable",
        auth_type: "api_key",
        status: "connected",
        granted_scopes: ["data.records:write"],
      };
    },
    readCredential: async ({ credentialKey }) => {
      calls.push(`read:${credentialKey}`);
      return { credentialType: "api_key", plaintext: PAT };
    },
  });
  const result = await resolve({
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "airtable",
    capabilityId: "airtable.create_record",
  });
  assert.deepEqual(result, { kind: "api_key", value: PAT });
  assert.deepEqual(calls, [`load:${USER_A}:${CONNECTION_ID}`, "read:api_key"]);
});

test("D2 resolver rejects cross-owner, connector mismatch, and missing scope before vault access", async () => {
  for (const scenario of ["owner", "connector", "scope"] as const) {
    let loads = 0;
    let reads = 0;
    const resolve = createDelegatedCredentialResolver({
      loadOwnedConnection: async () => {
        loads += 1;
        return {
          id: CONNECTION_ID, user_id: USER_A,
          connector_id: scenario === "connector" ? "slack" : "airtable",
          provider_family: scenario === "connector" ? "slack" : "airtable",
          auth_type: "api_key", status: "connected",
          granted_scopes: scenario === "scope" ? [] : ["data.records:write"],
        };
      },
      readCredential: async () => { reads += 1; return { credentialType: "api_key", plaintext: PAT }; },
    });
    await assert.rejects(resolve({
      authenticatedUserId: USER_A,
      workflowOwnerId: scenario === "owner" ? USER_B : USER_A,
      connectionId: CONNECTION_ID,
      connectorId: "airtable",
      capabilityId: "airtable.create_record",
    }), DelegatedCredentialError);
    assert.equal(reads, 0);
    assert.equal(loads, scenario === "owner" ? 0 : 1);
  }
});

test("D2 Airtable success uses the one fixed official URL and returns only recordId", async () => {
  let calls = 0;
  const logs: Array<Record<string, unknown>> = [];
  const replay = new ReplayStore();
  const result = await invoke({
    replayStore: replay,
    logs,
    providerFetch: async (url, init) => {
      calls += 1;
      assert.equal(String(url), `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${PAT}`);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        records: [{ fields: { Name: "CrazyLoops D2 acceptance" } }],
      });
      return new Response(JSON.stringify({ records: [{ id: RECORD_ID, fields: { Name: "secret response detail" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.body, {
    protocolVersion: 1,
    requestId: (result.body as { requestId: string }).requestId,
    ok: true,
    acknowledged: true,
    output: { recordId: RECORD_ID },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PAT));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${PAT}|secret response detail`));
  assert.doesNotMatch(replay.serializedClaims.join("\n"), new RegExp(PAT));
});

test("D2 caller cannot override host, method, token, headers, credential, or connection", async () => {
  let providerCalls = 0;
  for (const key of ["url", "hostname", "method", "token", "authorization", "headers", "credential", "connectionId"]) {
    const result = await invoke({
      envelope: makeEnvelope({ adapterInput: {
        baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "test" }, [key]: "attacker",
      } }),
      providerFetch: async () => { providerCalls += 1; return new Response(); },
    });
    assert.equal(errorCategory(result), "DELEGATED_EXECUTION_FAILED", key);
  }
  assert.equal(providerCalls, 0);
});

test("D2 validates identifiers, field bounds, JSON size, and nested depth", async () => {
  const invalidInputs = [
    { baseId: "bad", tableId: TABLE_ID, fields: { Name: "x" } },
    { baseId: BASE_ID, tableId: "bad", fields: { Name: "x" } },
    { baseId: BASE_ID, tableId: TABLE_ID, fields: {} },
    { baseId: BASE_ID, tableId: TABLE_ID, fields: { ["x".repeat(101)]: "x" } },
    { baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "x".repeat(65 * 1024) } },
    { baseId: BASE_ID, tableId: TABLE_ID, fields: { Deep: [[[[[[[[["x"]]]]]]]]] } },
  ];
  for (const adapterInput of invalidInputs) {
    const result = await invoke({ envelope: makeEnvelope({ adapterInput }) });
    assert.equal(errorCategory(result), "DELEGATED_EXECUTION_FAILED");
  }
});

test("D2 unsupported Airtable operation and capability version fail before decrypt/provider", async () => {
  for (const envelope of [
    makeEnvelope({ capabilityId: "airtable.delete_record" }),
    makeEnvelope({ capabilityVersion: 2 }),
  ]) {
    let providerCalls = 0;
    const result = await invoke({
      envelope,
      keyRing: new Map([[1, randomBytes(32)]]),
      providerFetch: async () => { providerCalls += 1; return new Response(); },
    });
    assert.equal(errorCategory(result), "DELEGATED_UNSUPPORTED_CAPABILITY");
    assert.equal(providerCalls, 0);
  }
});

test("D2 replay claim precedes decrypt, duplicate capsule is rejected, and credential is zeroized", async () => {
  const envelope = makeEnvelope();
  const replay = new ReplayStore();
  let credentialReference: Buffer | null = null;
  let executions = 0;
  const adapters = new Map([[
    "airtable.create_record@1",
    {
      execute: async (context: Record<string, unknown>) => {
        executions += 1;
        assert.equal(Buffer.isBuffer(context.credential), true);
        credentialReference = context.credential as Buffer;
        assert.equal(credentialReference.toString("utf8"), PAT);
        return { recordId: RECORD_ID };
      },
    },
  ]]);
  const first = await invoke({ envelope, replayStore: replay, adapters });
  assert.equal(first.body.ok, true);
  assert.ok(credentialReference);
  assert.equal((credentialReference as Buffer).every((byte) => byte === 0), true);
  const second = await invoke({ envelope, replayStore: replay, adapters });
  assert.equal(errorCategory(second), "DELEGATED_REPLAYED");
  assert.equal(executions, 1);

  const replayBeforeDecrypt = await invoke({
    envelope: makeEnvelope(),
    keyRing: new Map([[1, randomBytes(32)]]),
    replayStore: { claim: async () => false },
  });
  assert.equal(errorCategory(replayBeforeDecrypt), "DELEGATED_REPLAYED");
});

test("D2 maps Airtable 401/403/429/5xx and invalid configuration safely", async () => {
  const cases = [
    [401, "DELEGATED_AUTH_FAILED", false],
    [403, "DELEGATED_AUTH_FAILED", false],
    [429, "DELEGATED_RATE_LIMITED", true],
    [500, "DELEGATED_UNAVAILABLE", true],
    [503, "DELEGATED_UNAVAILABLE", true],
    [400, "DELEGATED_EXECUTION_FAILED", false],
  ] as const;
  for (const [status, category, retryable] of cases) {
    const result = await invoke({
      providerFetch: async () => new Response(`raw-provider-error-${PAT}`, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    });
    assert.equal(errorCategory(result), category);
    assert.equal((result.body as { retryable: boolean }).retryable, retryable);
    assert.doesNotMatch(JSON.stringify(result), /raw-provider-error|patD2Credential/);
  }
});

test("D2 timeout is bounded and mapped without an internal retry", async () => {
  let attempts = 0;
  const result = await invoke({
    adapterTimeoutMs: 100,
    providerFetch: async (_url, init) => {
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("provider timeout containing secret");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });
  assert.equal(errorCategory(result), "DELEGATED_TIMEOUT");
  assert.equal((result.body as { retryable: boolean }).retryable, true);
  assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(result), /provider timeout|secret/);
});

test("D2 rejects malformed JSON, oversized responses, redirects, and ambiguous network failure", async () => {
  const cases: Array<[typeof fetch, string, boolean]> = [
    [async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }), "DELEGATED_BAD_RESPONSE", false],
    [async () => new Response("x".repeat(65 * 1024), { status: 200, headers: { "Content-Type": "application/json" } }), "DELEGATED_BAD_RESPONSE", false],
    [async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }), "DELEGATED_BAD_RESPONSE", false],
    [async () => { throw new Error(`ambiguous ${PAT}`); }, "DELEGATED_EXECUTION_FAILED", false],
  ];
  for (const [providerFetch, category, retryable] of cases) {
    const logs: Array<Record<string, unknown>> = [];
    const result = await invoke({ providerFetch, logs });
    assert.equal(errorCategory(result), category);
    assert.equal((result.body as { retryable: boolean }).retryable, retryable);
    assert.doesNotMatch(JSON.stringify({ result, logs }), new RegExp(PAT));
  }
});

test("D2 Vercel executor sends only a capsule and emits credential-free telemetry", async () => {
  await withRunnerEnvironment(async () => {
    const telemetry: unknown[] = [];
    let sourceCredential: Buffer | null = null;
    let serializedRunnerRequest = "";
    const executor = new ConnectorRunnerExecutor({
      now: () => FIXED_NOW,
      captureTelemetry: async (event) => { telemetry.push(event); },
      resolveCredential: async () => {
        sourceCredential = Buffer.from(PAT, "utf8");
        return sourceCredential;
      },
      fetchImplementation: async (_url, init) => {
        serializedRunnerRequest = String(init?.body ?? "");
        const result = await processRunnerRequest({
          rawBody: serializedRunnerRequest,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          transportSecret: TRANSPORT_SECRET,
          keyRing: new Map([[1, Buffer.from(WRAP_KEY)]]),
          replayStore: new ReplayStore(),
          now: FIXED_NOW,
          fetchImplementation: async () => new Response(JSON.stringify({ records: [{ id: RECORD_ID }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const request: CapabilityExecutionRequest = {
      authenticatedUserId: USER_A,
      workflowOwnerId: USER_A,
      credentialReference: { connectionId: CONNECTION_ID, connectorId: "airtable" },
      envelope: {
        protocolVersion: 1,
        requestId: randomUUID(), executionId: randomUUID(), workflowVersionId: randomUUID(),
        stepId: "airtable_create", capabilityId: "airtable.create_record", capabilityVersion: 1,
        mode: "TEST", idempotencyKey: "d2-one-create",
        input: { baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "D2" } },
      },
    };
    const result = await executor.execute(request);
    assert.deepEqual(result, { ok: true, acknowledged: true, output: { recordId: RECORD_ID } });
    assert.doesNotMatch(serializedRunnerRequest, new RegExp(PAT));
    assert.doesNotMatch(JSON.stringify(telemetry), new RegExp(PAT));
    assert.ok(sourceCredential);
    assert.equal((sourceCredential as Buffer).every((byte) => byte === 0), true);
  });
});

test("D2 owner-only acceptance route ignores caller configuration and returns sanitized output", async () => {
  const environment = {
    D2_AIRTABLE_ACCEPTANCE_ENABLED: "true",
    D2_AIRTABLE_ACCEPTANCE_SECRET: "dedicated-d2-acceptance-secret".padEnd(64, "x"),
    D2_AIRTABLE_ACCEPTANCE_OWNER_ID: USER_A,
    D2_AIRTABLE_ACCEPTANCE_CONNECTION_ID: CONNECTION_ID,
    D2_AIRTABLE_ACCEPTANCE_BASE_ID: BASE_ID,
    D2_AIRTABLE_ACCEPTANCE_TABLE_ID: TABLE_ID,
    D2_AIRTABLE_ACCEPTANCE_FIELDS_JSON: JSON.stringify({ Name: "server-owned acceptance" }),
  };
  let captured: CapabilityExecutionRequest | null = null;
  const executor = {
    execute: async (request: CapabilityExecutionRequest) => {
      captured = request;
      return { ok: true as const, acknowledged: true as const, output: { recordId: RECORD_ID } };
    },
  };
  const unauthorized = await handleAirtableAcceptancePost(new Request("https://example.test/api", { method: "POST" }), { environment, executor });
  assert.equal(unauthorized.status, 401);
  const response = await handleAirtableAcceptancePost(new Request("https://example.test/api", {
    method: "POST",
    headers: { Authorization: `Bearer ${environment.D2_AIRTABLE_ACCEPTANCE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ baseId: "appATTACKER000000", token: PAT, fields: { Name: "attacker" } }),
  }), { environment, executor });
  assert.equal(response.status, 200);
  const capturedRequest = captured as unknown as CapabilityExecutionRequest;
  assert.deepEqual(capturedRequest.credentialReference, { connectionId: CONNECTION_ID, connectorId: "airtable" });
  assert.deepEqual(capturedRequest.envelope.input, {
    baseId: BASE_ID, tableId: TABLE_ID, fields: { Name: "server-owned acceptance" },
  });
  assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(PAT));
  assert.equal((await executeAirtableAcceptance({ environment, executor })).ok, true);
});
