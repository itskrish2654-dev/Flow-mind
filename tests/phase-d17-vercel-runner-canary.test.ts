import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assessCapability, CAPABILITY_REGISTRY } from "../lib/capability-registry";
import {
  handleConnectorRunnerCanaryPost,
  isConnectorRunnerCanaryAuthorized,
} from "../lib/operations/connector-runner-canary";
import type { OperationalEvent } from "../lib/observability";
import { processRunnerRequest } from "../services/connector-runner/src/runner.mjs";

const OPERATOR_SECRET = "d17-independent-operator-secret".padEnd(64, "o");
const TRANSPORT_SECRET = "d17-runner-transport-secret".padEnd(64, "t");
const WRAP_KEY = randomBytes(32);
const FIXED_NOW = 1_800_000_000_000;
const SERVER_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
  "40000000-0000-4000-8000-000000000004",
];

function enabledEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    D17_CONNECTOR_RUNNER_CANARY_ENABLED: "true",
    CONNECTOR_RUNNER_CANARY_SECRET: OPERATOR_SECRET,
    DELEGATED_EXECUTION_ENABLED: "true",
    CONNECTOR_RUNNER_EXECUTION_ENABLED: "true",
    CONNECTOR_RUNNER_URL: "https://runner.example.test/v1/execute",
    CONNECTOR_RUNNER_SECRET: TRANSPORT_SECRET,
    CONNECTOR_RUNNER_TIMEOUT_MS: "1000",
    CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION: "1",
    CONNECTOR_RUNNER_WRAP_KEY_V1: WRAP_KEY.toString("base64"),
    ...overrides,
  };
}

function authorizedRequest(body: Record<string, unknown> = {}): Request {
  return new Request("https://www.crazy-loops.com/api/operations/connector-runner-canary", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPERATOR_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function withProcessEnvironment<T>(
  environment: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function deterministicUUIDs(): () => string {
  let index = 0;
  return () => SERVER_IDS[index++] ?? "50000000-0000-4000-8000-000000000005";
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

class OneClaimReplayStore {
  private claimed = false;

  async claim(): Promise<boolean> {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
}

test("D1.7 route is disabled by default and missing configuration fails closed", async () => {
  const disabled = await handleConnectorRunnerCanaryPost(authorizedRequest(), {
    environment: {},
  });
  assert.equal(disabled.status, 401);
  assert.deepEqual(await disabled.json(), { ok: false, error: "Unauthorized" });

  const missingSecret = await handleConnectorRunnerCanaryPost(authorizedRequest(), {
    environment: { D17_CONNECTOR_RUNNER_CANARY_ENABLED: "true" },
  });
  assert.equal(missingSecret.status, 401);
});

test("D1.7 authentication rejects bad, wrong-length, and reused secrets safely", async () => {
  const environment = enabledEnvironment();
  for (const authorization of [
    "Bearer wrong",
    `Bearer ${"x".repeat(OPERATOR_SECRET.length)}`,
    "Basic wrong",
    "",
  ]) {
    const request = new Request("https://www.crazy-loops.com/api/operations/connector-runner-canary", {
      method: "POST",
      headers: { authorization },
    });
    assert.doesNotThrow(() => isConnectorRunnerCanaryAuthorized(request, environment));
    assert.equal(isConnectorRunnerCanaryAuthorized(request, environment), false);
    const response = await handleConnectorRunnerCanaryPost(request, { environment });
    assert.equal(response.status, 401);
  }

  const reused = enabledEnvironment({ CRON_SECRET: OPERATOR_SECRET });
  assert.equal(isConnectorRunnerCanaryAuthorized(authorizedRequest(), reused), false);
  const reusedWrapKey = enabledEnvironment({ CONNECTOR_RUNNER_WRAP_KEY_V7: OPERATOR_SECRET });
  assert.equal(isConnectorRunnerCanaryAuthorized(authorizedRequest(), reusedWrapKey), false);
});

test("D1.7 ignores caller material and executes the real ConnectorRunnerExecutor", async () => {
  const environment = enabledEnvironment();
  const telemetry: OperationalEvent[] = [];
  const runnerLogs: Array<Record<string, unknown>> = [];
  const captured: { url?: string; body?: string } = {};
  let requests = 0;
  const fetchImplementation: typeof fetch = async (url, init) => {
    requests += 1;
    captured.url = String(url);
    captured.body = String(init?.body ?? "");
    const result = await processRunnerRequest({
      rawBody: captured.body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      transportSecret: TRANSPORT_SECRET,
      keyRing: new Map([[1, Buffer.from(WRAP_KEY)]]),
      replayStore: new OneClaimReplayStore(),
      now: FIXED_NOW,
      adapterTimeoutMs: 100,
      logger: (event: Record<string, unknown>) => { runnerLogs.push(event); },
    });
    return Response.json(result.body, { status: result.status });
  };
  const hostile = {
    credential: "CALLER_CONTROLLED_CREDENTIAL",
    runnerUrl: "https://attacker.example/v1/execute",
    capabilityId: "salesforce",
    requestId: "caller-request",
    executionId: "caller-execution",
    workflowVersionId: "caller-version",
    ownerId: "caller-owner",
    transportSecret: "caller-secret",
    wrappingKey: "caller-key",
  };

  const response = await withProcessEnvironment(environment, () =>
    handleConnectorRunnerCanaryPost(authorizedRequest(hostile), {
      environment,
      fetchImplementation,
      captureTelemetry: async (event) => { telemetry.push(event); },
      now: () => FIXED_NOW,
      randomBytes: (size) => Buffer.alloc(size, 0xab),
      randomUUID: deterministicUUIDs(),
    }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    requestId: SERVER_IDS[0],
    executionId: SERVER_IDS[1],
    proofVerified: true,
  });
  assert.equal(requests, 1);
  assert.equal(captured.url, "https://runner.example.test/v1/execute");
  const envelope = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
  assert.equal(envelope.requestId, SERVER_IDS[0]);
  assert.equal(envelope.executionId, SERVER_IDS[1]);
  assert.equal(envelope.workflowVersionId, SERVER_IDS[2]);
  assert.equal(envelope.capabilityId, "internal.connector_runner_canary");
  assert.equal(envelope.capabilityVersion, 1);
  assert.equal(envelope.mode, "TEST");
  assert.deepEqual(envelope.input, { simulation: "success" });

  const serialized = JSON.stringify({ response: envelope, telemetry, runnerLogs });
  const serializedTelemetry = JSON.stringify(telemetry);
  assert.doesNotMatch(serialized, /CALLER_CONTROLLED_CREDENTIAL|attacker\.example|salesforce/);
  assert.doesNotMatch(serialized, /CRAZYLOOPS_D17_CANARY_/);
  assert.doesNotMatch(serialized, new RegExp(OPERATOR_SECRET));
  assert.doesNotMatch(serialized, new RegExp(TRANSPORT_SECRET));
  assert.doesNotMatch(serializedTelemetry, /credential|capsule|ciphertext|secret|authorization/i);
});

test("D1.7 proof mismatch and transport failure return only generic safe errors", async () => {
  const environment = enabledEnvironment();
  const events: OperationalEvent[] = [];
  const mismatchedProof: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { requestId: string };
    return Response.json({
      protocolVersion: 1,
      requestId: body.requestId,
      ok: true,
      acknowledged: true,
      output: { proof: "0".repeat(64) },
    });
  };
  const mismatch = await withProcessEnvironment(environment, () =>
    handleConnectorRunnerCanaryPost(authorizedRequest(), {
      environment,
      fetchImplementation: mismatchedProof,
      captureTelemetry: async (event) => { events.push(event); },
      now: () => FIXED_NOW,
      randomBytes: (size) => Buffer.alloc(size, 0xcd),
      randomUUID: deterministicUUIDs(),
    }));
  assert.equal(mismatch.status, 502);
  assert.deepEqual(await mismatch.json(), {
    ok: false,
    error: "Connector Runner canary failed.",
  });
  assert.match(JSON.stringify(events), /CANARY_PROOF_MISMATCH/);

  const privateFailure = "CRAZYLOOPS_D17_CANARY_PRIVATE_EXCEPTION";
  const failed = await withProcessEnvironment(environment, () =>
    handleConnectorRunnerCanaryPost(authorizedRequest(), {
      environment,
      fetchImplementation: async () => { throw new Error(privateFailure); },
      captureTelemetry: async (event) => { events.push(event); },
      now: () => FIXED_NOW,
      randomUUID: deterministicUUIDs(),
    }));
  assert.equal(failed.status, 502);
  const failedText = await failed.text();
  assert.doesNotMatch(failedText, new RegExp(privateFailure));
  assert.doesNotMatch(failedText, /stack|capsule|ciphertext|credential|secret/i);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(privateFailure));
});

test("D1.7 fake credential lifecycle is high-entropy, local, and zeroized", () => {
  const source = readFileSync(
    join(process.cwd(), "lib", "operations", "connector-runner-canary.ts"),
    "utf8",
  );
  assert.match(source, /CRAZYLOOPS_D17_CANARY_/);
  assert.match(source, /dependencies\.randomBytes \?\? randomBytes/);
  assert.match(source, /makeRandomBytes\(48\)/);
  assert.match(source, /return Buffer\.from/);
  assert.match(source, /finally \{[\s\S]*credential\.fill\(0\)/);
  assert.match(source, /new ConnectorRunnerExecutor/);
  assert.match(source, /resolveCredential: async \(\) => credential/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/);

  const customResolvers = [join(process.cwd(), "app"), join(process.cwd(), "lib")]
    .flatMap(typescriptFiles)
    .filter((path) => /resolveCredential:\s*async/.test(readFileSync(path, "utf8")))
    .map((path) => path.replaceAll("\\", "/"));
  assert.equal(customResolvers.length, 1);
  assert.match(customResolvers[0] ?? "", /lib\/operations\/connector-runner-canary\.ts$/);
});

test("D1.7 route cannot ingest credentials or import the vault", () => {
  const route = readFileSync(
    join(process.cwd(), "app", "api", "operations", "connector-runner-canary", "route.ts"),
    "utf8",
  );
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function (?:GET|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(route, /request\.(?:json|text|formData|arrayBuffer)\(/);
  assert.doesNotMatch(route, /connection-vault|createAdminClient|credential|runnerUrl|capabilityId/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_/);
});

test("D1.7 canary stays invisible to normal workflows and disabled by default", () => {
  const capability = CAPABILITY_REGISTRY["internal.connector_runner_canary"];
  assert.equal(capability.internalOnly, true);
  assert.equal(capability.plannerVisible, false);
  assert.equal(capability.availableInProduction, false);
  assert.deepEqual(capability.aliases, []);
  assert.equal(assessCapability("internal.connector_runner_canary", "production").available, false);

  const environment = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  assert.match(environment, /^CONNECTOR_RUNNER_EXECUTION_ENABLED=false$/m);
  assert.match(environment, /^D17_CONNECTOR_RUNNER_CANARY_ENABLED=false$/m);
  assert.doesNotMatch(environment, /NEXT_PUBLIC_(?:D17|CONNECTOR_RUNNER)/);
});

test("D1.7 owner procedure requires real Vercel and runner persistence scans", () => {
  const procedure = readFileSync(
    join(process.cwd(), "docs", "connector-runner", "D17_VERCEL_CANARY.md"),
    "utf8",
  );
  assert.match(procedure, /VERCEL_PLAINTEXT_CANARY_OCCURRENCES=0/);
  assert.match(procedure, /RUNNER_PLAINTEXT_CANARY_OCCURRENCES=0/);
  assert.match(procedure, /Automated and local tests do not\s+constitute Vercel-origin acceptance/);
  assert.match(procedure, /D17_CONNECTOR_RUNNER_CANARY_ENABLED=false/);
  assert.match(procedure, /https:\/\/runner\.crazy-loops\.com\/v1\/execute/);
});
