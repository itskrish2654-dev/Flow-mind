import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ActivepiecesExecutor } from "../lib/executors/activepieces";
import {
  createDelegatedCredentialResolver,
  DelegatedCredentialError,
  type DelegatedCredentialErrorCategory,
  type DelegatedCredentialResolverDependencies,
} from "../lib/executors/delegated-credentials";
import { resolveExecutor, resolveExecutorSelection } from "../lib/executors/router";
import { CompiledWorkflowSchema } from "../lib/schemas/workflow";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";
const SECRET = "delegated-secret-value-that-must-never-be-logged";

function connectedSlackConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    user_id: USER_A,
    connector_id: "slack",
    provider_family: "slack",
    auth_type: "oauth2" as const,
    status: "connected" as const,
    granted_scopes: ["channels:read", "chat:write"],
    ...overrides,
  };
}

function resolverFixture(options: {
  connection?: ReturnType<typeof connectedSlackConnection> | null;
  readCredential?: DelegatedCredentialResolverDependencies["readCredential"];
} = {}) {
  const calls = {
    loads: [] as Array<{ userId: string; connectionId: string }>,
    reads: [] as Array<{ userId: string; connectionId: string; credentialKey: string }>,
  };
  const dependencies: DelegatedCredentialResolverDependencies = {
    async loadOwnedConnection(input) {
      calls.loads.push(input);
      return options.connection === undefined ? connectedSlackConnection() : options.connection;
    },
    async readCredential(input) {
      calls.reads.push(input);
      if (options.readCredential) return options.readCredential(input);
      return { credentialType: "oauth_access_token", plaintext: SECRET };
    },
  };
  return { resolve: createDelegatedCredentialResolver(dependencies), calls };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    authenticatedUserId: USER_A,
    workflowOwnerId: USER_A,
    connectionId: CONNECTION_ID,
    connectorId: "slack",
    capabilityId: "slack_send_channel_message",
    ...overrides,
  };
}

async function rejectsWithCategory(
  promise: Promise<unknown>,
  category: DelegatedCredentialErrorCategory,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof DelegatedCredentialError, true);
    assert.equal((error as DelegatedCredentialError).category, category);
    assert.doesNotMatch((error as Error).message, /token|secret|Slack|Notion|Google/i);
    return true;
  });
}

test("D1 owner resolves only the latest narrow credential projection", async () => {
  const fixture = resolverFixture();
  const result = await fixture.resolve(validInput());
  assert.deepEqual(result, { kind: "oauth2_bearer", value: SECRET });
  assert.deepEqual(fixture.calls.loads, [{ userId: USER_A, connectionId: CONNECTION_ID }]);
  assert.deepEqual(fixture.calls.reads, [{ userId: USER_A, connectionId: CONNECTION_ID, credentialKey: "access_token" }]);
  assert.deepEqual(Object.keys(result).sort(), ["kind", "value"]);
});

test("D1 cross-user workflow ownership is rejected before database access", async () => {
  const fixture = resolverFixture();
  await rejectsWithCategory(
    fixture.resolve(validInput({ workflowOwnerId: USER_B })),
    "DELEGATED_CREDENTIAL_AUTH_FAILED",
  );
  assert.equal(fixture.calls.loads.length, 0);
  assert.equal(fixture.calls.reads.length, 0);
});

test("D1 revoked connection is rejected before vault access", async () => {
  const fixture = resolverFixture({ connection: connectedSlackConnection({ status: "revoked" }) });
  await rejectsWithCategory(
    fixture.resolve(validInput()),
    "DELEGATED_CREDENTIAL_CONNECTION_UNAVAILABLE",
  );
  assert.equal(fixture.calls.reads.length, 0);
});

test("D1 connector and provider mismatches fail closed", async () => {
  const wrongRequest = resolverFixture();
  await rejectsWithCategory(
    wrongRequest.resolve(validInput({ connectorId: "notion" })),
    "DELEGATED_CREDENTIAL_CONNECTOR_MISMATCH",
  );
  assert.equal(wrongRequest.calls.loads.length, 0);

  const wrongRecord = resolverFixture({ connection: connectedSlackConnection({ provider_family: "notion" }) });
  await rejectsWithCategory(
    wrongRecord.resolve(validInput()),
    "DELEGATED_CREDENTIAL_CONNECTOR_MISMATCH",
  );
  assert.equal(wrongRecord.calls.reads.length, 0);
});

test("D1 missing or wrongly typed vault credentials are rejected", async () => {
  const missing = resolverFixture({ readCredential: async () => { throw new Error("missing"); } });
  await rejectsWithCategory(missing.resolve(validInput()), "DELEGATED_CREDENTIAL_MISSING");

  const wrongType = resolverFixture({
    readCredential: async () => ({ credentialType: "webhook_secret", plaintext: SECRET }),
  });
  await rejectsWithCategory(wrongType.resolve(validInput()), "DELEGATED_CREDENTIAL_MISSING");
});

test("D1 insufficient scopes are rejected before vault access", async () => {
  const fixture = resolverFixture({
    connection: connectedSlackConnection({ granted_scopes: ["channels:read"] }),
  });
  await rejectsWithCategory(
    fixture.resolve(validInput()),
    "DELEGATED_CREDENTIAL_SCOPE_MISSING",
  );
  assert.equal(fixture.calls.reads.length, 0);
});

test("D1 browser-facing connection view has no vault or secret serialization path", () => {
  const source = readFileSync(join(process.cwd(), "lib", "connectors", "connection-view.ts"), "utf8");
  assert.doesNotMatch(source, /connector_connection_credentials|readConnectionSecret|readConnectionCredential/);
  assert.doesNotMatch(source, /access[_-]?token|refresh[_-]?token|ciphertext|auth[_-]?tag|nonce/i);
  assert.match(source, /id,provider_family,external_account_label,status,last_refreshed_at,updated_at/);
});

test("D1 resolver emits no plaintext logs or telemetry", async () => {
  const fixture = resolverFixture();
  const captured: unknown[] = [];
  const original = { error: console.error, warn: console.warn, info: console.info, log: console.log };
  console.error = (...values) => { captured.push(values); };
  console.warn = (...values) => { captured.push(values); };
  console.info = (...values) => { captured.push(values); };
  console.log = (...values) => { captured.push(values); };
  try {
    await fixture.resolve(validInput());
  } finally {
    Object.assign(console, original);
  }
  assert.equal(captured.length, 0);
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET));
});

test("D1 bridge protocol v1 echo remains compatible and contains no credential field", async () => {
  const env = {
    DELEGATED_EXECUTION_ENABLED: process.env.DELEGATED_EXECUTION_ENABLED,
    ACTIVEPIECES_EXECUTOR_ENABLED: process.env.ACTIVEPIECES_EXECUTOR_ENABLED,
    ACTIVEPIECES_BRIDGE_URL: process.env.ACTIVEPIECES_BRIDGE_URL,
    ACTIVEPIECES_BRIDGE_SECRET: process.env.ACTIVEPIECES_BRIDGE_SECRET,
  };
  process.env.DELEGATED_EXECUTION_ENABLED = "true";
  process.env.ACTIVEPIECES_EXECUTOR_ENABLED = "true";
  process.env.ACTIVEPIECES_BRIDGE_URL = "https://worker.example.test/echo/sync";
  process.env.ACTIVEPIECES_BRIDGE_SECRET = "d1-bridge-secret".padEnd(64, "x");
  let received: Record<string, unknown> | null = null;
  try {
    const executor = new ActivepiecesExecutor({
      captureTelemetry: async () => undefined,
      fetchImplementation: async (_url, init) => {
        received = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({
          ok: true,
          protocolVersion: 1,
          requestId: received.requestId,
          acknowledged: true,
          output: (received.input ?? {}) as Record<string, unknown>,
        }));
      },
    });
    const result = await executor.execute({
      authenticatedUserId: USER_A,
      workflowOwnerId: USER_A,
      envelope: {
        protocolVersion: 1,
        requestId: "40000000-0000-4000-8000-000000000004",
        executionId: "50000000-0000-4000-8000-000000000005",
        workflowVersionId: "60000000-0000-4000-8000-000000000006",
        stepId: "echo",
        capabilityId: "internal.bridge_echo",
        capabilityVersion: 1,
        mode: "TEST",
        idempotencyKey: "echo-once",
        input: { message: "CrazyLoops delegated execution works" },
      },
    });
    assert.equal(result.ok, true);
    const captured = received as unknown as Record<string, unknown> | null;
    assert.equal(captured?.protocolVersion, 1);
    assert.equal(Object.hasOwn(captured ?? {}, "credential"), false);
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET));
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("D1 native executor selection remains unchanged", () => {
  const workflow = CompiledWorkflowSchema.parse({
    workflowName: "Native",
    summary: "Native",
    steps: [{ id: "store", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store" }],
  });
  assert.deepEqual(resolveExecutorSelection(workflow.steps[0], "flowmind_data_store"), {
    kind: "native",
    capabilityVersion: 1,
  });
});

test("D1 unsupported capability and unknown executor fail closed", async () => {
  const fixture = resolverFixture();
  await rejectsWithCategory(
    fixture.resolve(validInput({ capabilityId: "airtable", connectorId: "airtable" })),
    "DELEGATED_CREDENTIAL_UNSUPPORTED",
  );
  assert.equal(fixture.calls.loads.length, 0);
  assert.throws(
    () => resolveExecutor({ kind: "unknown" as "native", capabilityVersion: 1 }),
    /temporarily unavailable/,
  );
});

test("D1 delegated flags remain independent kill switches", async () => {
  const previous = {
    delegated: process.env.DELEGATED_EXECUTION_ENABLED,
    executor: process.env.ACTIVEPIECES_EXECUTOR_ENABLED,
  };
  let calls = 0;
  try {
    for (const [delegated, executorFlag] of [["false", "true"], ["true", "false"]]) {
      process.env.DELEGATED_EXECUTION_ENABLED = delegated;
      process.env.ACTIVEPIECES_EXECUTOR_ENABLED = executorFlag;
      const result = await new ActivepiecesExecutor({
        captureTelemetry: async () => undefined,
        fetchImplementation: async () => { calls += 1; return new Response(); },
      }).execute({
        authenticatedUserId: USER_A,
        workflowOwnerId: USER_A,
        envelope: {
          protocolVersion: 1,
          requestId: "70000000-0000-4000-8000-000000000007",
          executionId: "80000000-0000-4000-8000-000000000008",
          workflowVersionId: "90000000-0000-4000-8000-000000000009",
          stepId: "echo",
          capabilityId: "internal.bridge_echo",
          capabilityVersion: 1,
          mode: "TEST",
          idempotencyKey: "disabled",
          input: { message: "disabled" },
        },
      });
      assert.deepEqual(result, { ok: false, errorCategory: "DELEGATED_DISABLED", retryable: false });
    }
    assert.equal(calls, 0);
  } finally {
    if (previous.delegated === undefined) delete process.env.DELEGATED_EXECUTION_ENABLED;
    else process.env.DELEGATED_EXECUTION_ENABLED = previous.delegated;
    if (previous.executor === undefined) delete process.env.ACTIVEPIECES_EXECUTOR_ENABLED;
    else process.env.ACTIVEPIECES_EXECUTOR_ENABLED = previous.executor;
  }
});

test("D1 bridge input cannot select owner, provider, credential key, or secret", async () => {
  const fixture = resolverFixture();
  const result = await fixture.resolve(validInput({
    providerFamily: "notion",
    credentialKey: "refresh_token",
    accessToken: "attacker-controlled",
    bridgeConnectionId: USER_B,
  }));
  assert.deepEqual(result, { kind: "oauth2_bearer", value: SECRET });
  assert.deepEqual(fixture.calls.reads, [{ userId: USER_A, connectionId: CONNECTION_ID, credentialKey: "access_token" }]);
  assert.doesNotMatch(JSON.stringify(result), /attacker-controlled|refresh_token|notion/i);
});

test("D1 credential rotation is observed on the next resolution", async () => {
  let current = "first-runtime-token";
  const fixture = resolverFixture({
    readCredential: async () => ({ credentialType: "oauth_access_token", plaintext: current }),
  });
  assert.equal((await fixture.resolve(validInput())).value, "first-runtime-token");
  current = "rotated-runtime-token";
  assert.equal((await fixture.resolve(validInput())).value, "rotated-runtime-token");
  assert.equal(fixture.calls.reads.length, 2);
});

test("D1 revocation removes delegated authorization immediately", async () => {
  let status: "connected" | "revoked" = "connected";
  let secretPresent = true;
  const fixture = resolverFixture({
    readCredential: async () => {
      if (!secretPresent) throw new Error("deleted");
      return { credentialType: "oauth_access_token", plaintext: SECRET };
    },
  });
  const originalLoad = fixture.resolve;
  assert.equal((await originalLoad(validInput())).value, SECRET);

  status = "revoked";
  secretPresent = false;
  const revoked = resolverFixture({
    connection: connectedSlackConnection({ status }),
    readCredential: async () => { throw new Error("deleted"); },
  });
  await rejectsWithCategory(
    revoked.resolve(validInput()),
    "DELEGATED_CREDENTIAL_CONNECTION_UNAVAILABLE",
  );
  assert.equal(revoked.calls.reads.length, 0);
});

test("D1 documentation records the Community Edition boundary and rejects plaintext webhook auth", () => {
  const documentation = readFileSync(
    join(process.cwd(), "docs", "activepieces", "DELEGATED_CREDENTIAL_MODEL.md"),
    "utf8",
  );
  assert.match(documentation, /0\.88\.3/);
  assert.match(documentation, /Model A/);
  assert.match(documentation, /plaintext token in the webhook body can therefore be retained/i);
  assert.match(documentation, /Protocol v1 remains byte-for-byte an echo-only contract/);
  assert.match(documentation, /API-key provisioning is feature\s+gated/i);
});
