import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import {
  ActivepiecesExecutor,
  createBridgeBodyDigest,
  createBridgeSignature,
} from "../lib/executors/activepieces";
import {
  consumeDelegatedCredential,
  createDelegatedCredentialCapsule,
  DelegatedCapsuleError,
  parseDelegatedWrapKeyRing,
  runCredentialCanaryAdapter,
  type CanarySimulation,
  type DelegatedCapsuleBinding,
  type DelegatedCapsuleClaim,
  type DelegatedCredentialCapsule,
  type DelegatedWrapKeyRing,
} from "../lib/executors/delegated-capsule";
import {
  createDelegatedCredentialResolver,
  DelegatedCredentialError,
} from "../lib/executors/delegated-credentials";
import { resolveExecutor } from "../lib/executors/router";

const NOW = 1_800_000_000_000;
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";

function encodedKey(): string {
  return randomBytes(32).toString("base64");
}

function keyRing(activeVersion = 2): DelegatedWrapKeyRing {
  return parseDelegatedWrapKeyRing({
    serializedKeys: JSON.stringify({ 1: encodedKey(), 2: encodedKey() }),
    activeVersion: String(activeVersion),
  });
}

function binding(overrides: Partial<DelegatedCapsuleBinding> = {}): DelegatedCapsuleBinding {
  return {
    protocolVersion: 2,
    requestId: "40000000-0000-4000-8000-000000000004",
    executionId: "50000000-0000-4000-8000-000000000005",
    workflowVersionId: "60000000-0000-4000-8000-000000000006",
    stepId: "step_canary",
    capabilityId: "internal.credential_canary",
    capabilityVersion: 1,
    ...overrides,
  };
}

function capsule(
  credential: string,
  ring = keyRing(),
  bound = binding(),
): DelegatedCredentialCapsule {
  return createDelegatedCredentialCapsule({
    credential,
    binding: bound,
    keyRing: ring,
    now: NOW,
  });
}

function claimOnce(): DelegatedCapsuleClaim {
  const seen = new Set<string>();
  return async ({ fingerprint }) => {
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  };
}

function freshCanary(): string {
  return `CRAZYLOOPS_CANARY_${randomBytes(32).toString("hex")}`;
}

function alterBase64(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] ^= 0xff;
  return bytes.toString("base64");
}

async function rejectedCategory(run: Promise<unknown>, category: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DelegatedCapsuleError);
    assert.equal(error.category, category);
    return true;
  });
}

test("D1.5 capsule encrypts and decrypts only inside a callback-scoped buffer", async () => {
  const canary = freshCanary();
  const ring = keyRing();
  const encrypted = capsule(canary, ring);
  assert.equal(JSON.stringify(encrypted).includes(canary), false);

  let observed: Buffer | null = null;
  const result = await consumeDelegatedCredential({
    capsule: encrypted,
    binding: binding(),
    keyRing: ring,
    claim: claimOnce(),
    now: NOW + 1,
    use: (credential) => {
      observed = credential;
      assert.equal(credential.toString("utf8"), canary);
      return "used";
    },
  });
  assert.equal(result, "used");
  assert.ok(observed);
  assert.equal((observed as Buffer).every((value) => value === 0), true);
});

test("D1.5 AAD binds every required execution identity", async () => {
  const ring = keyRing();
  const encrypted = capsule(freshCanary(), ring);
  const mutations: Array<Partial<DelegatedCapsuleBinding>> = [
    { requestId: "different-request" },
    { executionId: "different-execution" },
    { workflowVersionId: "different-version" },
    { stepId: "different-step" },
    { capabilityId: "different-capability" },
    { capabilityVersion: 2 },
  ];
  for (const mutation of mutations) {
    await rejectedCategory(
      consumeDelegatedCredential({
        capsule: encrypted,
        binding: binding(mutation),
        keyRing: ring,
        claim: claimOnce(),
        now: NOW + 1,
        use: () => undefined,
      }),
      "DELEGATED_CAPSULE_REJECTED",
    );
  }
});

test("D1.5 expiry and excessive future lifetime fail closed", async () => {
  const ring = keyRing();
  const encrypted = capsule(freshCanary(), ring);
  await rejectedCategory(
    consumeDelegatedCredential({
      capsule: encrypted,
      binding: binding(),
      keyRing: ring,
      claim: claimOnce(),
      now: encrypted.expiresAt,
      use: () => undefined,
    }),
    "DELEGATED_CAPSULE_EXPIRED",
  );
  await rejectedCategory(
    consumeDelegatedCredential({
      capsule: { ...encrypted, expiresAt: NOW + 120_001 },
      binding: binding(),
      keyRing: ring,
      claim: claimOnce(),
      now: NOW,
      use: () => undefined,
    }),
    "DELEGATED_CAPSULE_REJECTED",
  );
});

test("D1.5 ciphertext, nonce, tag, algorithm, and key-version corruption fail closed", async () => {
  const ring = keyRing();
  const encrypted = capsule(freshCanary(), ring);
  const corruptions: DelegatedCredentialCapsule[] = [
    { ...encrypted, ciphertext: alterBase64(encrypted.ciphertext) },
    { ...encrypted, nonce: alterBase64(encrypted.nonce) },
    { ...encrypted, authTag: alterBase64(encrypted.authTag) },
    { ...encrypted, algorithm: "invalid" as typeof encrypted.algorithm },
    { ...encrypted, keyVersion: 999 },
  ];
  for (const corrupted of corruptions) {
    await rejectedCategory(
      consumeDelegatedCredential({
        capsule: corrupted,
        binding: binding(),
        keyRing: ring,
        claim: claimOnce(),
        now: NOW + 1,
        use: () => undefined,
      }),
      "DELEGATED_CAPSULE_REJECTED",
    );
  }
});

test("D1.5 wrong wrapping key fails without exposing key material", async () => {
  const encrypted = capsule(freshCanary(), keyRing());
  await rejectedCategory(
    consumeDelegatedCredential({
      capsule: encrypted,
      binding: binding(),
      keyRing: keyRing(),
      claim: claimOnce(),
      now: NOW + 1,
      use: () => undefined,
    }),
    "DELEGATED_CAPSULE_REJECTED",
  );
});

test("D1.5 key rotation encrypts with active version and temporarily decrypts prior version", async () => {
  const versionOne = encodedKey();
  const versionTwo = encodedKey();
  const oldRing = parseDelegatedWrapKeyRing({
    serializedKeys: JSON.stringify({ 1: versionOne }),
    activeVersion: "1",
  });
  const rotatingRing = parseDelegatedWrapKeyRing({
    serializedKeys: JSON.stringify({ 1: versionOne, 2: versionTwo }),
    activeVersion: "2",
  });
  const retiredRing = parseDelegatedWrapKeyRing({
    serializedKeys: JSON.stringify({ 2: versionTwo }),
    activeVersion: "2",
  });
  const oldCapsule = capsule(freshCanary(), oldRing);
  const newCapsule = capsule(freshCanary(), rotatingRing);
  assert.equal(oldCapsule.keyVersion, 1);
  assert.equal(newCapsule.keyVersion, 2);

  await consumeDelegatedCredential({
    capsule: oldCapsule,
    binding: binding(),
    keyRing: rotatingRing,
    claim: claimOnce(),
    now: NOW + 1,
    use: () => undefined,
  });
  await rejectedCategory(
    consumeDelegatedCredential({
      capsule: oldCapsule,
      binding: binding(),
      keyRing: retiredRing,
      claim: claimOnce(),
      now: NOW + 1,
      use: () => undefined,
    }),
    "DELEGATED_CAPSULE_REJECTED",
  );
});

test("D1.5 a valid capsule can be consumed only once through an atomic claim", async () => {
  const ring = keyRing();
  const encrypted = capsule(freshCanary(), ring);
  const claim = claimOnce();
  const consume = () => consumeDelegatedCredential({
    capsule: encrypted,
    binding: binding(),
    keyRing: ring,
    claim,
    now: NOW + 1,
    use: () => "acknowledged",
  });
  assert.equal(await consume(), "acknowledged");
  await rejectedCategory(consume(), "DELEGATED_CAPSULE_REPLAYED");
});

test("D1.5 canary adapter returns a proof and never returns plaintext", async () => {
  const canary = freshCanary();
  const ring = keyRing();
  const result = await runCredentialCanaryAdapter({
    capsule: capsule(canary, ring),
    binding: binding(),
    keyRing: ring,
    claim: claimOnce(),
    now: NOW + 1,
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
  if (result.ok) assert.match(result.proof, /^[a-f0-9]{64}$/);
});

test("D1.5 all simulated provider and adapter failures are normalized and secret-free", async () => {
  const simulations: Array<[CanarySimulation, string, boolean]> = [
    ["adapter_throw", "DELEGATED_EXECUTION_FAILED", false],
    ["provider_401", "DELEGATED_AUTH_FAILED", false],
    ["provider_429", "DELEGATED_RATE_LIMITED", true],
    ["provider_500", "DELEGATED_UNAVAILABLE", true],
    ["timeout", "DELEGATED_TIMEOUT", true],
  ];
  for (const [simulation, expectedCategory, retryable] of simulations) {
    const canary = freshCanary();
    const ring = keyRing();
    const result = await runCredentialCanaryAdapter({
      capsule: capsule(canary, ring),
      binding: binding(),
      keyRing: ring,
      claim: claimOnce(),
      simulation,
      now: NOW + 1,
    });
    assert.deepEqual(result, { ok: false, errorCategory: expectedCategory, retryable });
    assert.equal(JSON.stringify(result).includes(canary), false);
  }
});

test("D1.5 decryption failures expose only generic error messages", async () => {
  const canary = freshCanary();
  const ring = keyRing();
  const encrypted = capsule(canary, ring);
  const corrupted = { ...encrypted, authTag: alterBase64(encrypted.authTag) };
  try {
    await consumeDelegatedCredential({
      capsule: corrupted,
      binding: binding(),
      keyRing: ring,
      claim: claimOnce(),
      now: NOW + 1,
      use: () => undefined,
    });
    assert.fail("Expected rejection.");
  } catch (error) {
    assert.ok(error instanceof DelegatedCapsuleError);
    assert.equal(error.message, "Delegated credential capsule was rejected.");
    assert.equal(JSON.stringify(error).includes(canary), false);
  }
});

test("D1.5 local serialized persistence surfaces contain zero plaintext canaries", async () => {
  const canary = freshCanary();
  const ring = keyRing();
  const encrypted = capsule(canary, ring);
  const envelope = {
    ...binding(),
    mode: "TEST",
    idempotencyKey: "d15-once",
    input: { operation: "canary_digest" },
    credentialCapsule: encrypted,
  };
  const result = await runCredentialCanaryAdapter({
    capsule: encrypted,
    binding: binding(),
    keyRing: ring,
    claim: claimOnce(),
    now: NOW + 1,
  });
  const surfaces = [
    JSON.stringify(envelope),
    JSON.stringify({ trigger: envelope, stepInput: envelope, stepOutput: result }),
    JSON.stringify({ workerLog: "adapter succeeded", requestId: binding().requestId }),
    JSON.stringify({ appLog: "flow completed", executionId: binding().executionId }),
    JSON.stringify({ telemetry: { event: "delegated_request_succeeded", protocolVersion: 2 } }),
    JSON.stringify({ response: result }),
  ];
  const occurrences = surfaces.reduce(
    (total, surface) => total + surface.split(canary).length - 1,
    0,
  );
  assert.equal(occurrences, 0);
});

test("D1.5 wrapping key configuration requires canonical 32-byte versioned keys", () => {
  const valid = encodedKey();
  assert.equal(parseDelegatedWrapKeyRing({
    serializedKeys: JSON.stringify({ 7: valid }),
    activeVersion: "7",
  }).activeVersion, 7);

  for (const candidate of [
    { serializedKeys: undefined, activeVersion: "1" },
    { serializedKeys: "{}", activeVersion: "1" },
    { serializedKeys: JSON.stringify({ 1: "short" }), activeVersion: "1" },
    { serializedKeys: JSON.stringify({ 1: valid }), activeVersion: "2" },
    { serializedKeys: JSON.stringify({ 0: valid }), activeVersion: "0" },
  ]) {
    assert.throws(
      () => parseDelegatedWrapKeyRing(candidate),
      (error: unknown) => error instanceof DelegatedCapsuleError &&
        error.category === "DELEGATED_CAPSULE_CONFIGURATION_INVALID",
    );
  }
});

test("D1.5 D1 resolver ownership remains enforced before connection lookup", async () => {
  let queried = false;
  const resolve = createDelegatedCredentialResolver({
    async loadOwnedConnection() {
      queried = true;
      return null;
    },
    async readCredential() {
      throw new Error("not called");
    },
  });
  await assert.rejects(
    resolve({
      authenticatedUserId: USER_B,
      workflowOwnerId: USER_A,
      connectionId: CONNECTION_ID,
      connectorId: "slack",
      capabilityId: "slack.send_message",
    }),
    (error: unknown) => error instanceof DelegatedCredentialError &&
      error.category === "DELEGATED_CREDENTIAL_AUTH_FAILED",
  );
  assert.equal(queried, false);
});

test("D1.5 protocol v1 echo template and executor remain capsule-free", () => {
  const executor = readFileSync(join(process.cwd(), "lib", "executors", "activepieces.ts"), "utf8");
  const types = readFileSync(join(process.cwd(), "lib", "executors", "types.ts"), "utf8");
  const template = readFileSync(
    join(process.cwd(), "docs", "activepieces", "crazyloops-bridge-worker-v1.json"),
    "utf8",
  );
  assert.doesNotMatch(executor, /credentialCapsule|protocolVersion:\s*2/);
  assert.doesNotMatch(types, /credentialCapsule|protocolVersion:\s*2/);
  assert.doesNotMatch(template, /credentialCapsule|internal\.credential_canary/);
  assert.match(template, /internal\.bridge_echo/);
});

test("D1.5 v2 worker is canary-only, same-boundary, and has no provider capability", () => {
  const path = join(
    process.cwd(),
    "docs",
    "activepieces",
    "crazyloops-bridge-worker-v2-canary-spike.json",
  );
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.ok(parsed);
  assert.match(raw, /protocolVersion: 2/);
  assert.match(raw, /createDecipheriv/);
  assert.match(raw, /plaintext\.fill\(0\)/);
  assert.match(raw, /CRAZYLOOPS_DELEGATED_WRAP_KEYS/);
  assert.match(raw, /internal\.credential_canary/);
  assert.doesNotMatch(raw, /Airtable|HubSpot|Shopify|access[_ -]?token|refresh[_ -]?token/i);
});

test("D1.5 exact AP worker code consumes ciphertext and returns only a sanitized proof", async () => {
  const raw = readFileSync(
    join(
      process.cwd(),
      "docs",
      "activepieces",
      "crazyloops-bridge-worker-v2-canary-spike.json",
    ),
    "utf8",
  );
  const template = JSON.parse(raw) as {
    template: {
      trigger: {
        nextAction: { settings: { sourceCode: { code: string } } };
      };
    };
  };
  const source = template.template.trigger.nextAction.settings.sourceCode.code
    .replace(
      "import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';",
      "const { createDecipheriv, createHash, createHmac, timingSafeEqual } = require('node:crypto');",
    )
    .replace("export const code =", "const code =");
  const worker = new Function(
    "require",
    "process",
    "Buffer",
    `${source}\nreturn code;`,
  )(createRequire(import.meta.url), process, Buffer) as (
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  const canary = freshCanary();
  const wrapKey = encodedKey();
  const ring = parseDelegatedWrapKeyRing({
    serializedKeys: JSON.stringify({ 1: wrapKey }),
    activeVersion: "1",
  });
  const now = Date.now();
  const bound = binding({
    requestId: "70000000-0000-4000-8000-000000000007",
    executionId: "80000000-0000-4000-8000-000000000008",
    workflowVersionId: "90000000-0000-4000-8000-000000000009",
  });
  const envelope = {
    ...bound,
    mode: "TEST",
    idempotencyKey: "d15-template-canary",
    input: { operation: "canary_digest" },
    credentialCapsule: createDelegatedCredentialCapsule({
      credential: canary,
      binding: bound,
      keyRing: ring,
      now,
    }),
  };
  const body = JSON.stringify(envelope);
  const bridgeSecret = "d15-template-bridge-secret".padEnd(64, "x");
  const timestamp = String(now);
  const digest = createBridgeBodyDigest(body);
  const signature = createBridgeSignature({
    secret: bridgeSecret,
    timestamp,
    requestId: bound.requestId,
    bodyDigest: digest,
  });
  const previous = {
    bridge: process.env.CRAZYLOOPS_BRIDGE_SECRET,
    keys: process.env.CRAZYLOOPS_DELEGATED_WRAP_KEYS,
  };
  process.env.CRAZYLOOPS_BRIDGE_SECRET = bridgeSecret;
  process.env.CRAZYLOOPS_DELEGATED_WRAP_KEYS = JSON.stringify({ 1: wrapKey });
  try {
    const result = await worker({
      event: {
        rawBody: body,
        headers: {
          "x-crazyloops-timestamp": timestamp,
          "x-crazyloops-request-id": bound.requestId,
          "x-crazyloops-content-sha256": digest,
          "x-crazyloops-signature": `v2=${signature}`,
        },
      },
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.match(JSON.stringify(result), /[a-f0-9]{64}/);
  } finally {
    if (previous.bridge === undefined) delete process.env.CRAZYLOOPS_BRIDGE_SECRET;
    else process.env.CRAZYLOOPS_BRIDGE_SECRET = previous.bridge;
    if (previous.keys === undefined) delete process.env.CRAZYLOOPS_DELEGATED_WRAP_KEYS;
    else process.env.CRAZYLOOPS_DELEGATED_WRAP_KEYS = previous.keys;
  }
});

test("D1.5 kill switches and native executor selection remain unchanged", async () => {
  assert.equal(resolveExecutor({ kind: "native", capabilityVersion: 1 }), null);
  const previous = {
    delegated: process.env.DELEGATED_EXECUTION_ENABLED,
    activepieces: process.env.ACTIVEPIECES_EXECUTOR_ENABLED,
  };
  process.env.DELEGATED_EXECUTION_ENABLED = "false";
  process.env.ACTIVEPIECES_EXECUTOR_ENABLED = "false";
  let fetched = false;
  try {
    const result = await new ActivepiecesExecutor({
      fetchImplementation: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
      captureTelemetry: async () => undefined,
    }).execute({
      authenticatedUserId: USER_A,
      workflowOwnerId: USER_A,
      envelope: {
        protocolVersion: 1,
        requestId: binding().requestId,
        executionId: binding().executionId,
        workflowVersionId: binding().workflowVersionId,
        stepId: "echo",
        capabilityId: "internal.bridge_echo",
        capabilityVersion: 1,
        mode: "TEST",
        idempotencyKey: "v1-unchanged",
        input: { message: "echo" },
      },
    });
    assert.deepEqual(result, {
      ok: false,
      errorCategory: "DELEGATED_DISABLED",
      retryable: false,
    });
    assert.equal(fetched, false);
  } finally {
    if (previous.delegated === undefined) delete process.env.DELEGATED_EXECUTION_ENABLED;
    else process.env.DELEGATED_EXECUTION_ENABLED = previous.delegated;
    if (previous.activepieces === undefined) delete process.env.ACTIVEPIECES_EXECUTOR_ENABLED;
    else process.env.ACTIVEPIECES_EXECUTOR_ENABLED = previous.activepieces;
  }
});

test("D1.5 server-only key names are documented without values or public prefixes", () => {
  const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  assert.match(env, /^CRAZYLOOPS_DELEGATED_WRAP_KEYS=$/m);
  assert.match(env, /^CRAZYLOOPS_DELEGATED_WRAP_ACTIVE_VERSION=$/m);
  assert.doesNotMatch(env, /NEXT_PUBLIC_CRAZYLOOPS_DELEGATED/);
  const script = readFileSync(
    join(process.cwd(), "scripts", "run-d15-canary-spike.ts"),
    "utf8",
  );
  assert.doesNotMatch(script, /console\.log\([^)]*(?:bridgeSecret|WRAP_KEY|canary\b)/);
});

test("D1.5 documentation records the unsupported AP piece boundary and owner scan", () => {
  const documentation = readFileSync(
    join(process.cwd(), "docs", "activepieces", "D15_CREDENTIAL_SAFE_ADAPTER_SPIKE.md"),
    "utf8",
  );
  assert.match(documentation, /piece-executor/);
  assert.match(documentation, /resolvedInput/);
  assert.match(documentation, /PLAINTEXT_CANARY_OCCURRENCES=0/);
  assert.match(documentation, /AP_SANDBOX_PROPAGATED_ENV_VARS/);
  assert.match(documentation, /\/api\/v1\/webhooks\/<exact-v2-flow-id>\/sync/);
  assert.match(documentation, /real-worker persistence scan has not been run/i);
});
