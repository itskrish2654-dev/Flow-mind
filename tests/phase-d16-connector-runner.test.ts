import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_REGISTRY, pinWorkflowExecutorSelections } from "../lib/capability-registry";
import { ActivepiecesExecutor } from "../lib/executors/activepieces";
import { ConnectorRunnerExecutor } from "../lib/executors/connector-runner";
import {
  CONNECTOR_RUNNER_PROTOCOL_VERSION,
  createConnectorRunnerBodyDigest,
  createConnectorRunnerCredentialCapsule,
  createConnectorRunnerSignature,
  type ConnectorRunnerCapsuleBinding,
  type ConnectorRunnerRequestEnvelope,
} from "../lib/executors/connector-runner-protocol";
import { resolveExecutor, resolveExecutorSelection } from "../lib/executors/router";
import type {
  CapabilityExecutionEnvelope,
  CapabilityExecutionRequest,
} from "../lib/executors/types";
import { CompiledWorkflowSchema } from "../lib/schemas/workflow";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { RedisReplayStore } from "../services/connector-runner/src/redis.mjs";
import {
  openCredentialCapsule,
  parseRunnerKeyRingFromEnvironment,
  processRunnerRequest,
} from "../services/connector-runner/src/runner.mjs";

const TRANSPORT_SECRET = "d16-runner-transport-secret".padEnd(64, "t");
const WRAP_KEY = randomBytes(32);
const WRAP_KEY_BASE64 = WRAP_KEY.toString("base64");
const WRONG_WRAP_KEY = randomBytes(32);
const FIXED_NOW = 1_800_000_000_000;
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const EXECUTION_ID = "30000000-0000-4000-8000-000000000003";
const VERSION_ID = "40000000-0000-4000-8000-000000000004";
const REQUEST_ID = "50000000-0000-4000-8000-000000000005";
const CANARY = `CRAZYLOOPS_CANARY_${randomBytes(32).toString("hex")}`;

class AtomicReplayStore {
  private readonly claims: Set<string>;

  constructor(claims = new Set<string>()) {
    this.claims = claims;
  }

  async claim({ fingerprint }: { fingerprint: string; ttlMs: number }): Promise<boolean> {
    if (this.claims.has(fingerprint)) return false;
    this.claims.add(fingerprint);
    return true;
  }
}

function withRunnerEnvironment<T>(
  run: () => Promise<T>,
  overrides: Record<string, string | undefined> = {},
): Promise<T> {
  const values: Record<string, string | undefined> = {
    DELEGATED_EXECUTION_ENABLED: "true",
    CONNECTOR_RUNNER_EXECUTION_ENABLED: "true",
    CONNECTOR_RUNNER_URL: "https://runner.example.test/v1/execute",
    CONNECTOR_RUNNER_SECRET: TRANSPORT_SECRET,
    CONNECTOR_RUNNER_TIMEOUT_MS: "1000",
    CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION: "1",
    CONNECTOR_RUNNER_WRAP_KEY_V1: WRAP_KEY_BASE64,
    ...overrides,
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function capabilityEnvelope(
  overrides: Partial<CapabilityExecutionEnvelope> = {},
): CapabilityExecutionEnvelope {
  return {
    protocolVersion: 1,
    requestId: REQUEST_ID,
    executionId: EXECUTION_ID,
    workflowVersionId: VERSION_ID,
    stepId: "runner_canary",
    capabilityId: "internal.connector_runner_canary",
    capabilityVersion: 1,
    mode: "TEST",
    idempotencyKey: `${EXECUTION_ID}:runner_canary:v1`,
    input: { simulation: "success" },
    ...overrides,
  };
}

function executionRequest(
  overrides: Partial<CapabilityExecutionRequest> = {},
): CapabilityExecutionRequest {
  return {
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    envelope: capabilityEnvelope(),
    ...overrides,
  };
}

function binding(
  overrides: Partial<ConnectorRunnerCapsuleBinding> = {},
): ConnectorRunnerCapsuleBinding {
  return {
    protocolVersion: CONNECTOR_RUNNER_PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    executionId: EXECUTION_ID,
    workflowVersionId: VERSION_ID,
    stepId: "runner_canary",
    capabilityId: "internal.connector_runner_canary",
    capabilityVersion: 1,
    ...overrides,
  };
}

function runnerEnvelope(input: {
  bindingOverrides?: Partial<ConnectorRunnerCapsuleBinding>;
  envelopeOverrides?: Partial<ConnectorRunnerRequestEnvelope>;
  credential?: string;
  wrapKey?: Buffer;
  capsuleNow?: number;
  ttlMs?: number;
} = {}): ConnectorRunnerRequestEnvelope {
  const capsuleBinding = binding(input.bindingOverrides);
  const credential = Buffer.from(input.credential ?? CANARY, "utf8");
  try {
    return {
      ...capsuleBinding,
      mode: "TEST",
      idempotencyKey: `${capsuleBinding.executionId}:${capsuleBinding.stepId}:v1`,
      input: { simulation: "success" },
      credentialCapsule: createConnectorRunnerCredentialCapsule({
        credential,
        binding: capsuleBinding,
        keyVersion: 1,
        wrapKey: input.wrapKey ?? WRAP_KEY,
        now: input.capsuleNow ?? FIXED_NOW,
        ttlMs: input.ttlMs,
      }),
      ...input.envelopeOverrides,
    };
  } finally {
    credential.fill(0);
  }
}

function signedHeaders(
  rawBody: string,
  input: {
    requestId?: string;
    timestamp?: number;
    secret?: string;
    digest?: string;
  } = {},
): Record<string, string> {
  const requestId = input.requestId ?? REQUEST_ID;
  const timestamp = String(input.timestamp ?? FIXED_NOW);
  const digest = input.digest ?? createConnectorRunnerBodyDigest(rawBody);
  const signature = createConnectorRunnerSignature({
    secret: input.secret ?? TRANSPORT_SECRET,
    timestamp,
    requestId,
    bodyDigest: digest,
  });
  return {
    "x-crazyloops-timestamp": timestamp,
    "x-crazyloops-request-id": requestId,
    "x-crazyloops-content-sha256": digest,
    "x-crazyloops-signature": `v1=${signature}`,
  };
}

async function invokeService(input: {
  envelope?: ConnectorRunnerRequestEnvelope;
  rawBody?: string;
  headers?: Record<string, string>;
  secret?: string;
  keyRing?: Map<number, Buffer>;
  replayStore?: { claim(input: { fingerprint: string; ttlMs: number }): Promise<boolean> };
  now?: number;
  adapterTimeoutMs?: number;
  logs?: Array<Record<string, unknown>>;
} = {}) {
  const envelope = input.envelope ?? runnerEnvelope();
  const rawBody = input.rawBody ?? JSON.stringify(envelope);
  return processRunnerRequest({
    rawBody,
    headers: input.headers ?? signedHeaders(rawBody, { requestId: envelope.requestId }),
    transportSecret: input.secret ?? TRANSPORT_SECRET,
    keyRing: input.keyRing ?? new Map([[1, Buffer.from(WRAP_KEY)]]),
    replayStore: input.replayStore ?? new AtomicReplayStore(),
    now: input.now ?? FIXED_NOW,
    adapterTimeoutMs: input.adapterTimeoutMs ?? 100,
    logger: (event: Record<string, unknown>) => { input.logs?.push(event); },
  });
}

function fakeRunnerFetch(input: {
  replayStore?: AtomicReplayStore;
  logs?: Array<Record<string, unknown>>;
  responseRequestId?: string;
} = {}) {
  let calls = 0;
  const fetchImplementation: typeof fetch = async (_url, init) => {
    calls += 1;
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    const rawBody = String(init?.body ?? "");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const result = await processRunnerRequest({
      rawBody,
      headers,
      transportSecret: TRANSPORT_SECRET,
      keyRing: new Map([[1, Buffer.from(WRAP_KEY)]]),
      replayStore: input.replayStore ?? new AtomicReplayStore(),
      now: FIXED_NOW,
      adapterTimeoutMs: 100,
      logger: (event: Record<string, unknown>) => { input.logs?.push(event); },
    });
    const body = input.responseRequestId
      ? { ...result.body, requestId: input.responseRequestId }
      : result.body;
    return new Response(JSON.stringify(body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImplementation, calls: () => calls };
}

function errorBody(result: Awaited<ReturnType<typeof invokeService>>): {
  errorCategory: string;
  retryable: boolean;
} {
  assert.equal(result.body.ok, false);
  return result.body as { errorCategory: string; retryable: boolean };
}

test("D1.6-1 executor selection is immutable and explicitly pinned", () => {
  const parsed = CompiledWorkflowSchema.parse({
    workflowName: "Runner canary",
    summary: "Internal only",
    steps: [{
      id: "runner_canary",
      type: "connector_action",
      capabilityId: "internal.connector_runner_canary",
      title: "Runner canary",
      description: "Internal only",
    }],
  });
  const pinned = pinWorkflowExecutorSelections(parsed);
  assert.deepEqual(pinned.steps[0].executor, { kind: "connector_runner", capabilityVersion: 1 });
  assert.deepEqual(resolveExecutorSelection(pinned.steps[0], "internal.connector_runner_canary"), {
    kind: "connector_runner",
    capabilityVersion: 1,
  });
  assert.throws(
    () => resolveExecutorSelection({ ...pinned.steps[0], executor: { kind: "native", capabilityVersion: 1 } }, "internal.connector_runner_canary"),
    /temporarily unavailable/,
  );
});

test("D1.6-2 unknown runner capability fails before credential resolution", async () => {
  await withRunnerEnvironment(async () => {
    let resolutions = 0;
    let requests = 0;
    const executor = new ConnectorRunnerExecutor({
      resolveCredential: async () => { resolutions += 1; return Buffer.from(CANARY); },
      fetchImplementation: async () => { requests += 1; return new Response(); },
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    });
    const result = await executor.execute(executionRequest({
      envelope: capabilityEnvelope({ capabilityId: "unknown.runner" }),
    }));
    assert.deepEqual(result, {
      ok: false,
      errorCategory: "DELEGATED_UNSUPPORTED_CAPABILITY",
      retryable: false,
    });
    assert.equal(resolutions, 0);
    assert.equal(requests, 0);
  });
});

test("D1.6-3 ownership mismatch fails before credential resolution", async () => {
  await withRunnerEnvironment(async () => {
    let resolutions = 0;
    const executor = new ConnectorRunnerExecutor({
      resolveCredential: async () => { resolutions += 1; return Buffer.from(CANARY); },
      fetchImplementation: async () => { throw new Error("must not run"); },
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    });
    const result = await executor.execute(executionRequest({ workflowOwnerId: USER_B }));
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false });
    assert.equal(resolutions, 0);
  });
});

test("D1.6-4 transport HMAC and capsule complete the canary path", async () => {
  await withRunnerEnvironment(async () => {
    const bridge = fakeRunnerFetch();
    const credential = Buffer.from(CANARY, "utf8");
    const executor = new ConnectorRunnerExecutor({
      resolveCredential: async () => credential,
      fetchImplementation: bridge.fetchImplementation,
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    });
    const result = await executor.execute(executionRequest());
    assert.deepEqual(result, {
      ok: true,
      acknowledged: true,
      output: {
        proof: createHmac("sha256", CANARY).update("CrazyLoops runner proof").digest("hex"),
      },
    });
    assert.equal(bridge.calls(), 1);
    assert.equal(credential.every((byte) => byte === 0), true);
  });
});

test("D1.6-5 invalid signature is rejected", async () => {
  const envelope = runnerEnvelope();
  const rawBody = JSON.stringify(envelope);
  const result = await invokeService({
    envelope,
    rawBody,
    headers: signedHeaders(rawBody, { secret: "wrong".padEnd(64, "w") }),
  });
  assert.equal(result.status, 401);
  assert.equal(errorBody(result).errorCategory, "DELEGATED_AUTH_FAILED");
});

test("D1.6-6 stale timestamps are rejected", async () => {
  const envelope = runnerEnvelope();
  const rawBody = JSON.stringify(envelope);
  const result = await invokeService({
    envelope,
    rawBody,
    headers: signedHeaders(rawBody, { timestamp: FIXED_NOW - 60_001 }),
  });
  assert.equal(result.status, 401);
  assert.equal(errorBody(result).errorCategory, "DELEGATED_AUTH_FAILED");
});

test("D1.6-7 digest mismatch is rejected before parsing", async () => {
  const rawBody = JSON.stringify(runnerEnvelope());
  const result = await invokeService({
    rawBody,
    headers: signedHeaders(rawBody, { digest: "0".repeat(64) }),
  });
  assert.equal(result.status, 401);
  assert.equal(errorBody(result).errorCategory, "DELEGATED_AUTH_FAILED");
});

test("D1.6-8 capsule success returns proof without plaintext", async () => {
  const result = await invokeService();
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CANARY));
});

test("D1.6-9 capsule corruption fails closed", async () => {
  const envelope = runnerEnvelope();
  const first = envelope.credentialCapsule.ciphertext[0];
  envelope.credentialCapsule.ciphertext = `${first === "A" ? "B" : "A"}${envelope.credentialCapsule.ciphertext.slice(1)}`;
  const result = await invokeService({ envelope });
  assert.equal(errorBody(result).errorCategory, "DELEGATED_CAPSULE_REJECTED");
});

test("D1.6-10 wrong wrapping key fails closed", async () => {
  const result = await invokeService({ keyRing: new Map([[1, Buffer.from(WRONG_WRAP_KEY)]]) });
  assert.equal(errorBody(result).errorCategory, "DELEGATED_CAPSULE_REJECTED");
});

test("D1.6-11 expired capsules fail closed", async () => {
  const envelope = runnerEnvelope({ capsuleNow: FIXED_NOW - 2_000, ttlMs: 1_000 });
  const result = await invokeService({ envelope });
  assert.equal(errorBody(result).errorCategory, "DELEGATED_CAPSULE_REJECTED");
});

test("D1.6-12 a capsule cannot cross request bindings", () => {
  const envelope = runnerEnvelope();
  envelope.requestId = randomUUID();
  assert.throws(
    () => openCredentialCapsule(envelope, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW),
    /request failed/,
  );
});

test("D1.6-13 a capsule cannot cross execution bindings", () => {
  const envelope = runnerEnvelope();
  envelope.executionId = randomUUID();
  assert.throws(
    () => openCredentialCapsule(envelope, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW),
    /request failed/,
  );
});

test("D1.6-14 a capsule cannot cross step bindings", () => {
  const envelope = runnerEnvelope();
  envelope.stepId = "different_step";
  assert.throws(
    () => openCredentialCapsule(envelope, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW),
    /request failed/,
  );
});

test("D1.6-15 a capsule cannot cross capability bindings", () => {
  const envelope = runnerEnvelope();
  envelope.capabilityId = "different.capability";
  assert.throws(
    () => openCredentialCapsule(envelope, new Map([[1, Buffer.from(WRAP_KEY)]]), FIXED_NOW),
    /request failed/,
  );
});

test("D1.6-16 Redis SET NX PX permits exactly one durable claim", async () => {
  const commands: string[] = [];
  const claims = new Set<string>();
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      const command = chunk.toString("utf8");
      commands.push(command);
      const key = /\r\n\$\d+\r\n(crazyloops:connector-runner:v1:replay:[a-f0-9]{64})\r\n/.exec(command)?.[1];
      if (!key) {
        socket.end("-ERR\r\n");
        return;
      }
      if (claims.has(key)) socket.end("$-1\r\n");
      else {
        claims.add(key);
        socket.end("+OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `redis://127.0.0.1:${address.port}/0`;
    const fingerprint = "a".repeat(64);
    const [first, second] = await Promise.all([
      new RedisReplayStore({ url }).claim({ fingerprint, ttlMs: 30_000 }),
      new RedisReplayStore({ url }).claim({ fingerprint, ttlMs: 30_000 }),
    ]);
    assert.deepEqual([first, second].sort(), [false, true]);
    assert.equal(await new RedisReplayStore({ url }).claim({ fingerprint, ttlMs: 30_000 }), false);
    const serialized = commands.join("\n");
    assert.match(serialized, /\r\nNX\r\n/);
    assert.match(serialized, /\r\nPX\r\n/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("D1.6-17 Redis unavailable fails closed", async () => {
  const result = await invokeService({
    replayStore: { claim: async () => { throw new Error("unavailable"); } },
  });
  assert.equal(result.status, 503);
  assert.equal(errorBody(result).errorCategory, "DELEGATED_REPLAY_UNAVAILABLE");
  assert.equal(errorBody(result).retryable, true);
});

test("D1.6-18 mismatched response request IDs fail closed", async () => {
  await withRunnerEnvironment(async () => {
    const bridge = fakeRunnerFetch({ responseRequestId: randomUUID() });
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(CANARY),
      fetchImplementation: bridge.fetchImplementation,
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    }).execute(executionRequest());
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_BAD_RESPONSE", retryable: false });
  });
});

test("D1.6-19 oversized requests are rejected before networking", async () => {
  await withRunnerEnvironment(async () => {
    let calls = 0;
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(CANARY),
      fetchImplementation: async () => { calls += 1; return new Response(); },
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    }).execute(executionRequest({
      envelope: capabilityEnvelope({ input: { value: "x".repeat(129 * 1024) } }),
    }));
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_EXECUTION_FAILED", retryable: false });
    assert.equal(calls, 0);
  });
});

test("D1.6-20 oversized responses fail closed", async () => {
  await withRunnerEnvironment(async () => {
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(CANARY),
      fetchImplementation: async () => new Response("x".repeat(65 * 1024)),
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    }).execute(executionRequest());
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_BAD_RESPONSE", retryable: false });
  });
});

test("D1.6-21 runner client timeout is bounded", async () => {
  await withRunnerEnvironment(async () => {
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(CANARY),
      fetchImplementation: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    }).execute(executionRequest());
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_TIMEOUT", retryable: true });
  });
});

test("D1.6-22 redirects are never followed", async () => {
  await withRunnerEnvironment(async () => {
    let redirectMode: RequestRedirect | undefined;
    const result = await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(CANARY),
      fetchImplementation: async (_url, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test" } });
      },
      captureTelemetry: async () => undefined,
      now: () => FIXED_NOW,
    }).execute(executionRequest());
    assert.equal(redirectMode, "manual");
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_BAD_RESPONSE", retryable: false });
  });
});

test("D1.6-23 telemetry contains no credential, capsule, transport secret, or body", async () => {
  await withRunnerEnvironment(async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = fakeRunnerFetch();
    await new ConnectorRunnerExecutor({
      resolveCredential: async () => Buffer.from(CANARY),
      fetchImplementation: bridge.fetchImplementation,
      captureTelemetry: async (event) => { events.push(event); },
      now: () => FIXED_NOW,
    }).execute(executionRequest());
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, new RegExp(CANARY));
    assert.doesNotMatch(serialized, new RegExp(TRANSPORT_SECRET));
    assert.doesNotMatch(serialized, /credential|capsule|ciphertext|requestBody|responseBody/i);
  });
});

test("D1.6-24 all runner error paths remain credential-free", async () => {
  for (const simulation of [
    "adapter_throw",
    "provider_401",
    "provider_429",
    "provider_500",
    "timeout",
  ]) {
    const logs: Array<Record<string, unknown>> = [];
    const envelope = runnerEnvelope({ envelopeOverrides: { input: { simulation } } });
    const result = await invokeService({ envelope, logs, adapterTimeoutMs: 100 });
    const serialized = JSON.stringify({ result, logs });
    assert.doesNotMatch(serialized, new RegExp(CANARY));
    assert.doesNotMatch(serialized, new RegExp(TRANSPORT_SECRET));
    assert.equal(result.body.ok, false);
  }
});

test("D1.6-25 native execution remains unchanged", async () => {
  const result = await executeWorkflowSteps({
    workflowId: "native",
    workflowName: "Native",
    steps: [{
      id: "store",
      type: "store_data",
      capabilityId: "flowmind_data_store",
      title: "Store",
      description: "Store",
    }],
    inputValues: { value: "safe" },
    mode: "test",
  });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, false);
});

test("D1.6-26 Activepieces executor selection remains unchanged", () => {
  assert.equal(new ActivepiecesExecutor().kind, "activepieces");
  assert.equal(resolveExecutor({ kind: "activepieces", capabilityVersion: 1 })?.kind, "activepieces");
});

test("D1.6-27 internal.bridge_echo remains Activepieces protocol v1", () => {
  const capability = CAPABILITY_REGISTRY["internal.bridge_echo"];
  assert.equal(capability.executionImplementation, "delegated:activepieces/internal.bridge_echo@1");
  assert.deepEqual(capability.executorVersions, { 1: "activepieces" });
  assert.equal(capability.defaultCapabilityVersion, 1);
});

test("D1.6-28 runner canary is internal and planner invisible", () => {
  const capability = CAPABILITY_REGISTRY["internal.connector_runner_canary"];
  assert.equal(capability.internalOnly, true);
  assert.equal(capability.plannerVisible, false);
  assert.equal(capability.availableInProduction, false);
  assert.deepEqual(capability.aliases, []);
  assert.doesNotMatch(JSON.stringify(capability.aliases), /canary|runner/i);
  const runnerSource = readFileSync(
    join(process.cwd(), "services", "connector-runner", "src", "runner.mjs"),
    "utf8",
  );
  const protocol = readFileSync(
    join(process.cwd(), "docs", "connector-runner", "PROTOCOL_V1.md"),
    "utf8",
  );
  const environment = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  assert.doesNotMatch(runnerSource, /\beval\s*\(|new Function|import\s*\(/);
  assert.doesNotMatch(environment, /NEXT_PUBLIC_CONNECTOR_RUNNER/);
  assert.match(protocol, /one adapter attempt/i);
  assert.match(protocol, /no dynamic import, eval, arbitrary code/i);
});

test("D1.6-29 disabled flags cause zero credential resolution and network requests", async () => {
  for (const overrides of [
    { DELEGATED_EXECUTION_ENABLED: "false" },
    { CONNECTOR_RUNNER_EXECUTION_ENABLED: "false" },
  ]) {
    await withRunnerEnvironment(async () => {
      let resolutions = 0;
      let requests = 0;
      const result = await new ConnectorRunnerExecutor({
        resolveCredential: async () => { resolutions += 1; return Buffer.from(CANARY); },
        fetchImplementation: async () => { requests += 1; return new Response(); },
        captureTelemetry: async () => undefined,
        now: () => FIXED_NOW,
      }).execute(executionRequest());
      assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_DISABLED", retryable: false });
      assert.equal(resolutions, 0);
      assert.equal(requests, 0);
    }, overrides);
  }
});

test("D1.6-30 transport, wrapping, Activepieces, and vault secrets cannot be reused", async () => {
  for (const overrides of [
    { CONNECTOR_RUNNER_SECRET: WRAP_KEY_BASE64 },
    { ACTIVEPIECES_BRIDGE_SECRET: TRANSPORT_SECRET },
    { FLOWMIND_CREDENTIAL_MASTER_KEY: WRAP_KEY_BASE64 },
  ]) {
    await withRunnerEnvironment(async () => {
      let resolutions = 0;
      let requests = 0;
      const result = await new ConnectorRunnerExecutor({
        resolveCredential: async () => { resolutions += 1; return Buffer.from(CANARY); },
        fetchImplementation: async () => { requests += 1; return new Response(); },
        captureTelemetry: async () => undefined,
        now: () => FIXED_NOW,
      }).execute(executionRequest());
      assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_DISABLED", retryable: false });
      assert.equal(resolutions, 0);
      assert.equal(requests, 0);
    }, overrides);
  }
});

test("D1.6-31 runner rotation accepts a bounded prior key version", () => {
  const nextKey = randomBytes(32);
  const keyRing = parseRunnerKeyRingFromEnvironment({
    ...process.env,
    CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION: "2",
    CONNECTOR_RUNNER_WRAP_KEY_V1: WRAP_KEY_BASE64,
    CONNECTOR_RUNNER_WRAP_KEY_V2: nextKey.toString("base64"),
  });
  const envelope = runnerEnvelope();
  const plaintext = openCredentialCapsule(envelope, keyRing, FIXED_NOW);
  try {
    assert.equal(plaintext.toString("utf8"), CANARY);
  } finally {
    plaintext.fill(0);
    for (const key of keyRing.values()) key.fill(0);
    nextKey.fill(0);
  }
});

test("D1.6-32 replay claim failures happen before credential decryption", async () => {
  const unavailable = await invokeService({
    keyRing: new Map([[1, Buffer.from(WRONG_WRAP_KEY)]]),
    replayStore: { claim: async () => { throw new Error("unavailable"); } },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(errorBody(unavailable).errorCategory, "DELEGATED_REPLAY_UNAVAILABLE");

  const replayed = await invokeService({
    keyRing: new Map([[1, Buffer.from(WRONG_WRAP_KEY)]]),
    replayStore: { claim: async () => false },
  });
  assert.equal(replayed.status, 409);
  assert.equal(errorBody(replayed).errorCategory, "DELEGATED_REPLAYED");
});

test("D1.6-33 canary script runs through an async main in the CommonJS repository", () => {
  const script = readFileSync(join(process.cwd(), "scripts", "run-d16-canary.ts"), "utf8");
  assert.match(script, /async function main\(\): Promise<void>/);
  assert.match(script, /main\(\)\.catch/);

  const probe = spawnSync(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "scripts", "run-d16-canary.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        D16_CANARY_CONFIRM: "",
        CONNECTOR_RUNNER_URL: "",
      },
    },
  );
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /Set D16_CANARY_CONFIRM=/);
  assert.doesNotMatch(`${probe.stdout}\n${probe.stderr}`, /top-level await/i);
});

test("D1.6-34 owner procedure keeps Redis private and separates evidence claims", () => {
  const ownerSetup = readFileSync(
    join(process.cwd(), "docs", "connector-runner", "OWNER_SETUP.md"),
    "utf8",
  );
  assert.match(ownerSetup, /docker network connect crazyloops-private redis/);
  assert.match(ownerSetup, /CONNECTOR_RUNNER_REDIS_URL=redis:\/\/redis:6379\/0/);
  assert.match(ownerSetup, /docker exec redis redis-cli --scan/);
  assert.doesNotMatch(ownerSetup, /^redis-cli\b/m);
  assert.match(ownerSetup, /Never publish Redis/);
  assert.match(ownerSetup, /Mandatory runner-host surfaces/);
  assert.match(ownerSetup, /CrazyLoops-side surfaces and truthful claims/);
  assert.match(ownerSetup, /does \*\*not\*\* prove that production Vercel runtime/);
  assert.match(ownerSetup, /does not add a public diagnostic route/);
});
