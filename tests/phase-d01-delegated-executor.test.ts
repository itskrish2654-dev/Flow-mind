import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_REGISTRY, pinWorkflowExecutorSelections } from "../lib/capability-registry";
import {
  ActivepiecesExecutor,
  createBridgeBodyDigest,
  createBridgeSignature,
} from "../lib/executors/activepieces";
import { resolveExecutor, resolveExecutorSelection } from "../lib/executors/router";
import type {
  CapabilityExecutionEnvelope,
  CapabilityExecutionRequest,
} from "../lib/executors/types";
import { CompiledWorkflowSchema } from "../lib/schemas/workflow";
import { executeWorkflowSteps } from "../lib/workflow-execution";

const SECRET = "d01-test-secret-".padEnd(64, "x");
const EXECUTION_ID = "10000000-0000-4000-8000-000000000001";
const VERSION_ID = "20000000-0000-4000-8000-000000000002";
const USER_A = "30000000-0000-4000-8000-000000000003";
const USER_B = "40000000-0000-4000-8000-000000000004";
const FIXED_NOW = 1_800_000_000_000;

function withBridgeEnvironment<T>(run: () => Promise<T>, overrides: Record<string, string | undefined> = {}): Promise<T> {
  const values: Record<string, string | undefined> = {
    DELEGATED_EXECUTION_ENABLED: "true",
    ACTIVEPIECES_EXECUTOR_ENABLED: "true",
    ACTIVEPIECES_BRIDGE_URL: "https://worker.example.test/bridge/sync",
    ACTIVEPIECES_BRIDGE_SECRET: SECRET,
    ACTIVEPIECES_BRIDGE_TIMEOUT_MS: "1000",
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

function envelope(overrides: Partial<CapabilityExecutionEnvelope> = {}): CapabilityExecutionEnvelope {
  return {
    protocolVersion: 1,
    requestId: "50000000-0000-4000-8000-000000000005",
    executionId: EXECUTION_ID,
    workflowVersionId: VERSION_ID,
    stepId: "step_internal",
    capabilityId: "internal.bridge_echo",
    capabilityVersion: 1,
    mode: "TEST",
    idempotencyKey: `${EXECUTION_ID}:step_internal:v1`,
    input: { message: "CrazyLoops delegated execution works" },
    ...overrides,
  };
}

function executionRequest(overrides: Partial<CapabilityExecutionRequest> = {}): CapabilityExecutionRequest {
  return {
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    envelope: envelope(),
    ...overrides,
  };
}

type FakeBridgeOptions = {
  status?: number;
  response?: (request: CapabilityExecutionEnvelope) => unknown;
  secret?: string;
};

function fakeBridge(options: FakeBridgeOptions = {}) {
  const calls: CapabilityExecutionEnvelope[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://worker.example.test/bridge/sync");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    const rawBody = String(init?.body ?? "");
    const request = JSON.parse(rawBody) as CapabilityExecutionEnvelope;
    calls.push(request);
    const headers = new Headers(init?.headers);
    const digest = createBridgeBodyDigest(rawBody);
    assert.equal(headers.get("x-crazyloops-content-sha256"), digest);
    assert.equal(headers.get("x-crazyloops-request-id"), request.requestId);
    const expected = createBridgeSignature({
      secret: options.secret ?? SECRET,
      timestamp: headers.get("x-crazyloops-timestamp") ?? "",
      requestId: request.requestId,
      bodyDigest: digest,
    });
    if (headers.get("x-crazyloops-signature") !== `v1=${expected}`) {
      return new Response(JSON.stringify({ error: "auth" }), { status: 403 });
    }
    const body = options.response?.(request) ?? {
      ok: true,
      protocolVersion: 1,
      requestId: request.requestId,
      acknowledged: true,
      output: request.input,
    };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImplementation };
}

function silentTelemetry(events: Array<Record<string, unknown>>) {
  return async (event: Record<string, unknown>) => { events.push(event); };
}

function internalStep() {
  return CompiledWorkflowSchema.parse({
    workflowName: "Internal probe",
    summary: "Internal probe",
    steps: [{
      id: "step_internal",
      type: "connector_action",
      capabilityId: "internal.bridge_echo",
      title: "Internal probe",
      description: "Internal probe",
      executor: { kind: "activepieces", capabilityVersion: 1 },
    }],
  }).steps;
}

test("D0.1 registry is internal-only and new versions pin immutable executor semantics", () => {
  const capability = CAPABILITY_REGISTRY["internal.bridge_echo"];
  assert.equal(capability.internalOnly, true);
  assert.equal(capability.plannerVisible, false);
  assert.deepEqual(capability.aliases, []);
  assert.equal(capability.executorVersions[1], "activepieces");

  const parsed = CompiledWorkflowSchema.parse({
    workflowName: "Store",
    summary: "Store",
    steps: [{ id: "step_1", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store" }],
  });
  assert.equal(parsed.steps[0].executor, undefined);
  assert.deepEqual(pinWorkflowExecutorSelections(parsed).steps[0].executor, { kind: "native", capabilityVersion: 1 });
  assert.deepEqual(resolveExecutorSelection(parsed.steps[0], "flowmind_data_store"), { kind: "native", capabilityVersion: 1 });
});

test("flags disabled fail closed without making a request", async () => {
  for (const overrides of [
    { DELEGATED_EXECUTION_ENABLED: "false" },
    { ACTIVEPIECES_EXECUTOR_ENABLED: "false" },
  ]) {
    await withBridgeEnvironment(async () => {
      const bridge = fakeBridge();
      const result = await new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW }).execute(executionRequest());
      assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_DISABLED", retryable: false });
      assert.equal(bridge.calls.length, 0);
    }, overrides);
  }
});

test("controlled fake bridge verifies HMAC and echoes exactly once", async () => {
  await withBridgeEnvironment(async () => {
    const bridge = fakeBridge();
    const events: Array<Record<string, unknown>> = [];
    const result = await new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: silentTelemetry(events), now: () => FIXED_NOW }).execute(executionRequest());
    assert.deepEqual(result, { ok: true, acknowledged: true, output: { message: "CrazyLoops delegated execution works" } });
    assert.equal(bridge.calls.length, 1);
    assert.deepEqual(events.map((event) => event.event), ["delegated_request_started", "delegated_request_succeeded"]);
  });
});

test("bad HMAC and 401/403 normalize to authentication failure", async () => {
  await withBridgeEnvironment(async () => {
    const badSignature = fakeBridge({ secret: "different-secret-value".padEnd(64, "x") });
    const result = await new ActivepiecesExecutor({ fetchImplementation: badSignature.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW }).execute(executionRequest());
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false });
    for (const status of [401, 403]) {
      const bridge = fakeBridge({ status });
      const mapped = await new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW }).execute(executionRequest());
      assert.deepEqual(mapped, { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false });
    }
  });
});

test("429 and provider 5xx statuses use controlled retry categories", async () => {
  await withBridgeEnvironment(async () => {
    for (const [status, category] of [[429, "DELEGATED_RATE_LIMITED"], [500, "DELEGATED_UNAVAILABLE"], [502, "DELEGATED_UNAVAILABLE"], [503, "DELEGATED_UNAVAILABLE"]] as const) {
      const bridge = fakeBridge({ status });
      const result = await new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW }).execute(executionRequest());
      assert.deepEqual(result, { ok: false, errorCategory: category, retryable: true });
      assert.equal(bridge.calls.length, 1);
    }
  });
});

test("timeout makes one request and returns the timeout category", async () => {
  await withBridgeEnvironment(async () => {
    let calls = 0;
    const hangingFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    const result = await new ActivepiecesExecutor({ fetchImplementation: hangingFetch, captureTelemetry: async () => undefined }).execute(executionRequest());
    assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_TIMEOUT", retryable: true });
    assert.equal(calls, 1);
  });
});

test("malformed, mismatched, redirected, and oversized responses are rejected", async () => {
  await withBridgeEnvironment(async () => {
    const cases: FakeBridgeOptions[] = [
      { response: () => "not-json" },
      { response: (request) => ({ ok: true, protocolVersion: 1, requestId: `${request.requestId}-wrong`, acknowledged: true, output: {} }) },
      { response: (request) => ({ ok: true, protocolVersion: 2, requestId: request.requestId, acknowledged: true, output: {} }) },
      { response: () => "x".repeat(65 * 1024) },
    ];
    for (const options of cases) {
      const bridge = fakeBridge(options);
      const result = await new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW }).execute(executionRequest());
      assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_BAD_RESPONSE", retryable: false });
    }
    let redirected = 0;
    const redirectFetch: typeof fetch = async () => {
      redirected += 1;
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } });
    };
    const redirectResult = await new ActivepiecesExecutor({ fetchImplementation: redirectFetch, captureTelemetry: async () => undefined, now: () => FIXED_NOW }).execute(executionRequest());
    assert.deepEqual(redirectResult, { ok: false, errorCategory: "DELEGATED_BAD_RESPONSE", retryable: false });
    assert.equal(redirected, 1);
  });
});

test("telemetry contains neither the bridge secret nor request/response payload", async () => {
  await withBridgeEnvironment(async () => {
    const bridge = fakeBridge();
    const events: Array<Record<string, unknown>> = [];
    await new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: silentTelemetry(events), now: () => FIXED_NOW }).execute(executionRequest());
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, new RegExp(SECRET));
    assert.doesNotMatch(serialized, /CrazyLoops delegated execution works/);
    assert.doesNotMatch(serialized, /authorization|fullInput|fullOutput/i);
  });
});

test("idempotency and TEST/LIVE modes cross the boundary without transport retries", async () => {
  await withBridgeEnvironment(async () => {
    const bridge = fakeBridge();
    const executor = new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW });
    const base = {
      userId: USER_A,
      workflowOwnerId: USER_A,
      workflowId: "60000000-0000-4000-8000-000000000006",
      workflowVersionId: VERSION_ID,
      workflowName: "Internal probe",
      steps: internalStep(),
      inputValues: { message: "CrazyLoops delegated execution works" },
      idempotencyKey: "logical-execution-key",
      telemetryExecutionId: EXECUTION_ID,
      allowInternalCapabilities: true,
      delegatedExecutor: executor,
    } as const;
    const tested = await executeWorkflowSteps({ ...base, mode: "test" });
    const live = await executeWorkflowSteps({ ...base, mode: "public-form" });
    assert.equal(tested.ok, true);
    assert.equal(live.ok, true);
    assert.equal(bridge.calls.length, 2);
    assert.equal(bridge.calls[0].mode, "TEST");
    assert.equal(bridge.calls[1].mode, "LIVE");
    assert.equal(bridge.calls[0].idempotencyKey, bridge.calls[1].idempotencyKey);
    assert.notEqual(bridge.calls[0].requestId, bridge.calls[1].requestId);
  });
});

test("A/B mismatch, internal browser path, unknown capability, and unknown executor all fail before delegation", async () => {
  await withBridgeEnvironment(async () => {
    const bridge = fakeBridge();
    const executor = new ActivepiecesExecutor({ fetchImplementation: bridge.fetchImplementation, captureTelemetry: async () => undefined, now: () => FIXED_NOW });
    const accountMismatch = await executor.execute(executionRequest({ workflowOwnerId: USER_B }));
    assert.deepEqual(accountMismatch, { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false });
    assert.equal(bridge.calls.length, 0);

    const blockedInternal = await executeWorkflowSteps({
      userId: USER_A,
      workflowId: "60000000-0000-4000-8000-000000000006",
      workflowName: "Blocked",
      steps: internalStep(),
      inputValues: { message: "blocked" },
      mode: "test",
      telemetryExecutionId: EXECUTION_ID,
      workflowVersionId: VERSION_ID,
      delegatedExecutor: executor,
    });
    assert.equal(blockedInternal.ok, false);
    assert.equal(blockedInternal.outputData.steps[0].status, "unsupported");
    assert.equal(bridge.calls.length, 0);

    const unknown = await executeWorkflowSteps({
      workflowId: "w",
      workflowName: "Unknown",
      steps: [{ id: "unknown", type: "connector_action", capabilityId: "unknown.capability", title: "Unknown", description: "Unknown", executor: { kind: "activepieces", capabilityVersion: 1 } }],
      inputValues: {},
      mode: "test",
      delegatedExecutor: executor,
    });
    assert.equal(unknown.ok, false);
    assert.equal(bridge.calls.length, 0);

    assert.throws(() => resolveExecutor({ kind: "future" as "native", capabilityVersion: 1 }), /temporarily unavailable/);
  });
});

test("native workflow behavior remains unchanged", async () => {
  const step = { id: "store", type: "store_data" as const, capabilityId: "flowmind_data_store", title: "Store", description: "Store internally" };
  const result = await executeWorkflowSteps({ workflowId: "w", workflowName: "Native", steps: [step], inputValues: { name: "Ada" }, mode: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.outputData.steps[0].status, "succeeded");
  assert.equal(result.delivered, false);
});

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    const stats = statSync(path);
    return stats.isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx|js|jsx)$/.test(name) ? [path] : [];
  });
}

test("customer-facing source and client environment expose no delegated infrastructure vocabulary", () => {
  const roots = [join(process.cwd(), "app"), join(process.cwd(), "components")];
  const source = roots.flatMap(sourceFiles).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(source, /Activepieces|internal\.bridge_echo|\bexecutor\b|\bflow ID\b|\bnode ID\b/i);
  assert.doesNotMatch(source, /NEXT_PUBLIC_(?:DELEGATED|ACTIVEPIECES|BRIDGE)/i);
  const executionAction = readFileSync(join(process.cwd(), "app", "actions", "execute.ts"), "utf8");
  assert.match(executionAction, /loadWorkflowSnapshot[\s\S]*steps: snapshot\.workflow\.steps/);
  assert.doesNotMatch(executionAction, /steps:\s*request\.data\.steps/);
});

test("worker template is valid, echo-only, HMAC-authenticated, and has retries disabled", () => {
  const templatePath = join(process.cwd(), "docs", "activepieces", "crazyloops-bridge-worker-v1.json");
  const raw = readFileSync(templatePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.name, "crazyloops-bridge-worker-v1");
  assert.match(raw, /internal\.bridge_echo/);
  assert.match(raw, /createHmac/);
  assert.match(raw, /CRAZYLOOPS_BRIDGE_SECRET/);
  assert.doesNotMatch(raw, new RegExp(SECRET));
  assert.equal((raw.match(/"retryOnFailure"/g) ?? []).length, 2);
  assert.equal((raw.match(/"value": false/g) ?? []).length >= 4, true);
});
