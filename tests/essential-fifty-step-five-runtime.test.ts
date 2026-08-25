import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";

import {
  createAdapterRegistry,
} from "../services/piece-runtime/src/adapter-registry.mjs";
import {
  buildInvocationPlan,
  executeWithContainerEngine,
  PieceContainerEngine,
} from "../services/piece-runtime/src/container-engine.mjs";
import { resolveManifestDestination } from "../services/piece-runtime/src/dns-policy.mjs";
import { PIECE_ERROR_CODES } from "../services/piece-runtime/src/errors.mjs";
import { isSafePublicAddress } from "../services/piece-runtime/src/ip-policy.mjs";
import {
  createManifestRegistry,
  HUBSPOT_GET_CONTACT_MANIFEST,
  REVIEWED_MANIFESTS,
} from "../services/piece-runtime/src/manifest-registry.mjs";
import { validateInvocationRequest } from "../services/piece-runtime/src/protocol.mjs";
import { executeReviewedPiece } from "../services/piece-runtime/src/runtime.mjs";
import { parseTlsClientHello } from "../services/piece-runtime/src/tls-client-hello.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId: "request-123",
    executionId: "execution-123",
    capabilityId: "hubspot.get_contact",
    capabilityVersion: 1,
    mode: "TEST",
    idempotencyKey: "idempotency-123",
    input: { contactId: "contact-123", properties: ["firstname"] },
    ...overrides,
  };
}

const SYNTHETIC_MANIFEST = {
  ...structuredClone(HUBSPOT_GET_CONTACT_MANIFEST),
  capabilityId: "fixture.echo_read",
  providerId: "fixture",
  piecePackage: "@crazyloops/test-piece",
  pieceVersion: "1.0.0-test",
  npmIntegrity: "sha512-test-fixture",
  upstreamSourceCommit: "0000000000000000000000000000000000000000",
  sourcePath: "tests/fixtures/piece",
  actionId: "echo-read",
  authProjection: "secret_text",
  destinations: [{ hostname: "fixture.example", port: 443, protocol: "tls" }],
  inputMapper: "fixture_input_v1",
  outputNormalizer: "fixture_output_v1",
};

const WRITE_MANIFEST = {
  ...structuredClone(SYNTHETIC_MANIFEST),
  capabilityId: "fixture.write",
  actionId: "write-action",
  expectedClassification: "WRITE",
  operationClassification: "WRITE",
};

const syntheticManifests = createManifestRegistry([SYNTHETIC_MANIFEST]);
const syntheticAdapters = createAdapterRegistry({
  inputMappers: {
    fixture_input_v1(input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid fixture input");
      const value = input as Record<string, unknown>;
      if (Object.keys(value).length !== 1 || typeof value.message !== "string" || value.message.length > 100) {
        throw new Error("invalid fixture input");
      }
      return { message: value.message };
    },
  },
  outputNormalizers: {
    fixture_output_v1(output: unknown) {
      const value = output as Record<string, unknown>;
      if (!value || typeof value.echo !== "string" || Object.keys(value).length !== 1) throw new Error("invalid fixture output");
      return { echo: value.echo };
    },
  },
});

function tlsHello(hostname?: string) {
  const extension = hostname === undefined
    ? Buffer.alloc(0)
    : (() => {
        const name = Buffer.from(hostname, "ascii");
        const list = Buffer.concat([Buffer.from([0, (name.length >> 8) & 0xff, name.length & 0xff]), name]);
        const data = Buffer.concat([Buffer.from([(list.length >> 8) & 0xff, list.length & 0xff]), list]);
        return Buffer.concat([Buffer.from([0, 0, (data.length >> 8) & 0xff, data.length & 0xff]), data]);
      })();
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    Buffer.from([(extension.length >> 8) & 0xff, extension.length & 0xff]),
    extension,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([1, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  return Buffer.concat([
    Buffer.from([22, 3, 1, (handshake.length >> 8) & 0xff, handshake.length & 0xff]),
    handshake,
  ]);
}

describe("Essential 50 Step 5A generic isolated piece runtime core", () => {
  test("reviewed HubSpot manifest is exact, deeply immutable, and pinned", () => {
    const manifest = REVIEWED_MANIFESTS.get("hubspot.get_contact", 1);
    assert.equal(manifest.piecePackage, "@activepieces/piece-hubspot");
    assert.equal(manifest.pieceVersion, "0.8.10");
    assert.equal(manifest.npmIntegrity, "sha512-P3svTd/XaaPhYfsOSz6YpgdfNcARRawqAddBGtJUxW/Grbc5InTdsvddlgSdyQtJxH+3UpxrKAR1VjlGJ4hfNA==");
    assert.equal(manifest.upstreamSourceCommit, "e7e44d4ef9a2a2bcec8cb611eb63af5df2ba019e");
    assert.equal(manifest.sourcePath, "packages/pieces/community/hubspot");
    assert.equal(manifest.actionId, "get-contact");
    assert.equal(manifest.operationClassification, "READ");
    assert.deepEqual(manifest.destinations, [{ hostname: "api.hubapi.com", port: 443, protocol: "tls" }]);
    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.destinations), true);
    assert.equal(Object.isFrozen(manifest.resourceLimits.sandbox), true);
    assert.throws(() => { (manifest.destinations[0] as { hostname: string }).hostname = "attacker.example"; });
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), destinations: [{ hostname: "*.example.com", port: 443, protocol: "tls" }] }]));
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), authProjection: "request_expression" }]));
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), resourceLimits: { ...structuredClone(manifest.resourceLimits), sandbox: { ...structuredClone(manifest.resourceLimits.sandbox), dockerSocket: true } } }]));
  });

  test("request schema contains business data only and rejects every metadata override", async () => {
    for (const key of ["piecePackage", "pieceVersion", "npmIntegrity", "actionId", "hostname", "port", "url", "method", "authProjection", "outputMapper", "resourceLimits"]) {
      const credential = Buffer.from("synthetic-credential");
      const result = await executeReviewedPiece({ request: request({ [key]: "attacker-controlled" }), credential });
      assert.equal(result.ok, false, key);
      assert.equal(result.errorCode, "PIECE_INVALID_INPUT", key);
      assert.ok(credential.every((byte) => byte === 0), key);
    }
    assert.throws(() => validateInvocationRequest(request({ input: [] })), /could not be completed/i);
  });

  test("unknown capability and wrong version fail before action loading", async () => {
    let loads = 0;
    for (const overrides of [{ capabilityId: "salesforce.read" }, { capabilityVersion: 2 }]) {
      const result = await executeReviewedPiece(
        { request: request(overrides), credential: Buffer.from("synthetic-credential") },
        { loadAction: async () => { loads += 1; throw new Error("must not load"); } },
      );
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, "PIECE_UNSUPPORTED_CAPABILITY");
    }
    assert.equal(loads, 0);
  });

  test("HubSpot auth/input/output projections are reviewed and one-attempt only", async () => {
    const canary = `E50_STEP5A_${randomBytes(24).toString("hex")}`;
    const credential = Buffer.from(canary);
    let attempts = 0;
    let captured: unknown = null;
    const result = await executeReviewedPiece(
      { request: request(), credential },
      {
        loadAction: async () => ({
          name: "get-contact",
          classification: "READ",
          async run(context: Record<string, unknown>) {
            attempts += 1;
            captured = context;
            return { id: "contact-123", properties: { firstname: "Casey" }, archived: false, ignored: canary };
          },
        }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(attempts, 1);
    assert.ok(captured && typeof captured === "object");
    assert.deepEqual((captured as Record<string, unknown>).auth, { access_token: canary });
    assert.deepEqual((captured as Record<string, unknown>).propsValue, { contactId: "contact-123", additionalPropertiesToRetrieve: ["firstname"] });
    assert.deepEqual(result.output, { contactId: "contact-123", properties: { firstname: "Casey" }, archived: false });
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.ok(credential.every((byte) => byte === 0));
  });

  test("second synthetic piece proves generic machinery and secret_text auth", async () => {
    const credential = Buffer.from("fixture-secret");
    const result = await executeReviewedPiece(
      {
        request: request({
          capabilityId: "fixture.echo_read",
          input: { message: "hello" },
        }),
        credential,
      },
      {
        manifests: syntheticManifests,
        adapters: syntheticAdapters,
        loadAction: async (manifest: Record<string, unknown>) => {
          assert.equal(manifest.piecePackage, "@crazyloops/test-piece");
          return {
            name: "echo-read",
            classification: "READ",
            async run({ auth, propsValue }: { auth: string; propsValue: { message: string } }) {
              assert.equal(auth, "fixture-secret");
              return { echo: propsValue.message };
            },
          };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { echo: "hello" });
    assert.ok(credential.every((byte) => byte === 0));
  });

  test("WRITE manifests are denied before loading or running an action", async () => {
    const manifests = createManifestRegistry([WRITE_MANIFEST]);
    let loaded = false;
    const result = await executeReviewedPiece(
      {
        request: request({ capabilityId: "fixture.write", input: { message: "write" } }),
        credential: Buffer.from("fixture-secret"),
      },
      { manifests, adapters: syntheticAdapters, loadAction: async () => { loaded = true; return {}; } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "PIECE_ACTION_NOT_ALLOWED");
    assert.equal(loaded, false);
  });

  test("wrong classification and unapproved action objects are rejected", async () => {
    for (const action of [
      { name: "create-contact", classification: "READ", run: async () => ({}) },
      { name: "get-contact", classification: "WRITE", run: async () => ({}) },
      { name: "get-contact", classification: "READ" },
    ]) {
      const result = await executeReviewedPiece(
        { request: request(), credential: Buffer.from("valid") },
        { loadAction: async () => action },
      );
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, "PIECE_ACTION_NOT_ALLOWED");
    }
  });

  test("malformed/oversized input and malformed/oversized credentials fail closed", async () => {
    const cases = [
      { request: request({ input: { contactId: "bad/id" } }), credential: Buffer.from("valid") },
      { request: request({ input: { contactId: "contact", properties: Array.from({ length: 26 }, (_, index) => `p_${index}`) } }), credential: Buffer.from("valid") },
      { request: request({ input: { contactId: "contact", properties: ["x".repeat(101)] } }), credential: Buffer.from("valid") },
      { request: request({ input: { contactId: "contact", padding: "x".repeat(40_000) } }), credential: Buffer.from("valid") },
      { request: request(), credential: Buffer.alloc(0) },
      { request: request(), credential: Buffer.alloc(16 * 1024 + 1, 1) },
      { request: request(), credential: Buffer.from([0xff, 0xfe]) },
    ];
    for (const invocation of cases) {
      const result = await executeReviewedPiece(invocation, { loadAction: async () => { throw new Error("must not load"); } });
      assert.equal(result.ok, false);
      assert.ok(["PIECE_INVALID_INPUT", "PIECE_INVALID_CREDENTIAL"].includes(result.errorCode));
    }
  });

  test("provider failures, timeout, malformed output, and output ceiling use bounded errors", async () => {
    const scenarios = [
      [{ status: 401, secret: "provider body" }, "PIECE_AUTH_FAILED", false],
      [{ status: 429, secret: "provider body" }, "PIECE_RATE_LIMITED", true],
      [{ status: 503, secret: "provider body" }, "PIECE_PROVIDER_UNAVAILABLE", true],
    ] as const;
    for (const [thrown, code, retryable] of scenarios) {
      const logs: unknown[] = [];
      const result = await executeReviewedPiece(
        { request: request(), credential: Buffer.from("valid") },
        { logger: (event: unknown) => logs.push(event), loadAction: async () => ({ name: "get-contact", classification: "READ", run: async () => { throw thrown; } }) },
      );
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, code);
      assert.equal(result.retryable, retryable);
      assert.equal(JSON.stringify({ result, logs }).includes("provider body"), false);
    }

    const timeoutManifest = structuredClone(HUBSPOT_GET_CONTACT_MANIFEST);
    timeoutManifest.resourceLimits.executionTimeoutMs = 10;
    const timeout = await executeReviewedPiece(
      { request: request(), credential: Buffer.from("valid") },
      { manifests: createManifestRegistry([timeoutManifest]), loadAction: async () => ({ name: "get-contact", classification: "READ", run: async () => new Promise(() => {}) }) },
    );
    assert.equal(timeout.ok, false);
    assert.equal(timeout.errorCode, "PIECE_TIMEOUT");

    const malformed = await executeReviewedPiece(
      { request: request(), credential: Buffer.from("valid") },
      { loadAction: async () => ({ name: "get-contact", classification: "READ", run: async () => ({ unexpected: true }) }) },
    );
    assert.equal(malformed.ok, false);
    assert.equal(malformed.errorCode, "PIECE_RESPONSE_INVALID");

    const oversized = await executeReviewedPiece(
      { request: request(), credential: Buffer.from("valid") },
      { loadAction: async () => ({ name: "get-contact", classification: "READ", run: async () => ({ id: "contact", properties: { huge: "x".repeat(200_000) } }) }) },
    );
    assert.equal(oversized.ok, false);
    assert.equal(oversized.errorCode, "PIECE_RESPONSE_INVALID");
  });

  test("IP, DNS, SNI, port, and redirect topology policies reject bypasses", async () => {
    for (const address of [
      "1.1.1.1", "2606:4700:4700::1111", "127.0.0.1", "10.0.0.1", "172.16.0.1",
      "192.168.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1",
    ]) {
      assert.equal(isSafePublicAddress(address), ["1.1.1.1", "2606:4700:4700::1111"].includes(address), address);
    }
    const destination = { hostname: "api.hubapi.com", port: 443, protocol: "tls" };
    const resolved = await resolveManifestDestination(destination, {
      resolve4: async () => [{ address: "8.8.8.8", ttl: 60 }],
      resolve6: async () => [],
    });
    assert.equal(resolved.pinnedAddress, "8.8.8.8");
    await assert.rejects(
      resolveManifestDestination(destination, {
        resolve4: async () => [{ address: "8.8.8.8", ttl: 60 }, { address: "10.0.0.1", ttl: 60 }],
        resolve6: async () => [],
      }),
    );
    await assert.rejects(resolveManifestDestination({ ...destination, hostname: "1.1.1.1" }));
    await assert.rejects(resolveManifestDestination({ ...destination, port: 444 }));
    assert.deepEqual(parseTlsClientHello(tlsHello("api.hubapi.com")), { hostname: "api.hubapi.com" });
    assert.equal(parseTlsClientHello(tlsHello("wrong.example")).hostname, "wrong.example");
    assert.equal(parseTlsClientHello(tlsHello()).error, "PIECE_EGRESS_DENIED");
    assert.equal(parseTlsClientHello(Buffer.from("not tls")).error, "PIECE_EGRESS_DENIED");
    const plan = buildInvocationPlan(request());
    assert.deepEqual(plan.sandbox.dnsAliases, ["api.hubapi.com"]);
    assert.equal(plan.sandbox.dnsAliases.includes("redirect.example"), false);
  });

  test("container plan preserves the accepted sandbox/gateway security policy", () => {
    const plan = buildInvocationPlan(request());
    assert.equal(plan.sandbox.internalOnlyNetwork, true);
    assert.equal(plan.sandbox.user, "65532:65532");
    assert.equal(plan.sandbox.readOnlyRoot, true);
    assert.equal(plan.sandbox.tmpfs, "/tmp:rw,noexec,nosuid,nodev,size=4m");
    assert.deepEqual(plan.sandbox.capDrop, ["ALL"]);
    assert.equal(plan.sandbox.noNewPrivileges, true);
    assert.equal(plan.sandbox.pidsLimit, 16);
    assert.equal(plan.sandbox.memoryBytes, 128 * 1024 * 1024);
    assert.equal(plan.sandbox.memorySwapBytes, 128 * 1024 * 1024);
    assert.equal(plan.sandbox.cpus, 0.5);
    assert.equal(plan.sandbox.nofile, "64:64");
    assert.deepEqual(plan.sandbox.mounts, []);
    assert.equal(plan.sandbox.dockerSocket, false);
    assert.equal(plan.gateway.user, "65532:65532");
    assert.equal(plan.gateway.memoryBytes, 64 * 1024 * 1024);
    assert.equal(plan.gateway.cpus, 0.25);
    assert.equal(plan.gateway.credentialAccess, false);
    assert.deepEqual(plan.gateway.publishedPorts, []);
    assert.equal(JSON.stringify(plan).includes("credential"), true);
    assert.equal(JSON.stringify(plan).includes("synthetic-secret"), false);
    assert.equal(Object.isFrozen(plan), true);
  });

  test("narrow engine cleanup is deterministic on success, crash, OOM/PID/CPU-style failure, and concurrency", async () => {
    class FakeEngine extends PieceContainerEngine {
      cleaned: string[] = [];
      calls = 0;
      constructor(private readonly failure: string | null = null) { super(); }
      async runInvocation({ plan, request: value }: { plan: { invocationId: string }; request: Record<string, unknown> }) {
        this.calls += 1;
        if (this.failure) throw new Error(this.failure);
        return { ok: true, invocationId: plan.invocationId, requestId: value.requestId };
      }
      async cleanupInvocation(plan: { invocationId: string }) { this.cleaned.push(plan.invocationId); }
    }

    const successEngine = new FakeEngine();
    const credentials = [Buffer.from("credential-a"), Buffer.from("credential-b")];
    const responses = await Promise.all(credentials.map((credential, index) => executeWithContainerEngine({
      engine: successEngine,
      request: request({ requestId: `request-${index}`, executionId: `execution-${index}`, idempotencyKey: `key-${index}` }),
      credential,
    })));
    assert.equal(new Set(responses.map((response) => (response as { invocationId: string }).invocationId)).size, 2);
    assert.equal(successEngine.cleaned.length, 2);
    assert.ok(credentials.every((credential) => credential.every((byte) => byte === 0)));

    for (const failure of ["sandbox crash", "oom", "pid exhaustion", "cpu loop", "filesystem write", "environment inspection", "child process attempt"]) {
      const engine = new FakeEngine(failure);
      const credential = Buffer.from("failure-credential");
      await assert.rejects(executeWithContainerEngine({ engine, request: request(), credential }));
      assert.equal(engine.cleaned.length, 1, failure);
      assert.ok(credential.every((byte) => byte === 0), failure);
    }
  });

  test("credential canary appears on zero returned/logged/inspect/report surfaces", async () => {
    const canary = `E50_STEP5A_SECRET_${randomBytes(32).toString("hex")}`;
    const logs: unknown[] = [];
    const credential = Buffer.from(canary);
    const result = await executeReviewedPiece(
      { request: request(), credential },
      {
        logger: (event: unknown) => logs.push(event),
        loadAction: async () => ({ name: "get-contact", classification: "READ", run: async () => ({ id: "contact-123", properties: {}, archived: false }) }),
      },
    );
    const plan = buildInvocationPlan(request());
    const report = { result, logs, inspect: plan, imageHistory: readFileSync(join(ROOT, "services/piece-runtime/Dockerfile.sandbox"), "utf8") };
    assert.equal(JSON.stringify(report).includes(canary), false);
    assert.ok(credential.every((byte) => byte === 0));
  });

  test("owner-run host harness keeps credentials on stdin and production disconnected", () => {
    const harness = readFileSync(join(ROOT, "scripts/e50-step5a-host-acceptance.sh"), "utf8");
    assert.match(harness, /docker network create --internal/);
    assert.match(harness, /--network "\$NETWORK"/);
    assert.match(harness, /--read-only/);
    assert.match(harness, /--cap-drop=ALL/);
    assert.match(harness, /--security-opt=no-new-privileges/);
    assert.match(harness, /--pids-limit=16/);
    assert.match(harness, /trap cleanup EXIT INT TERM/);
    assert.match(harness, /credentialBase64/);
    assert.doesNotMatch(harness, /--env[^\n]*(credential|secret|token)/i);
    assert.doesNotMatch(harness, /docker\.sock|--privileged|flow-mind-beta|crazy-loops\.com/i);
  });

  test("error vocabulary is bounded and production/customer surfaces remain disconnected", () => {
    assert.equal(new Set(PIECE_ERROR_CODES).size, PIECE_ERROR_CODES.length);
    for (const file of [
      "lib/capability-registry.ts",
      "lib/connectors/registry.ts",
      "lib/workflow-planner.ts",
      "lib/workflow-compiler.ts",
      "services/connector-runner/src/runner.mjs",
    ]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      assert.doesNotMatch(source, /services\/piece-runtime|hubspot\.get_contact/);
    }
    const loader = readFileSync(join(ROOT, "services/piece-runtime/src/piece-loader.mjs"), "utf8");
    assert.match(loader, /import\("@activepieces\/piece-hubspot"\)/);
    assert.doesNotMatch(loader, /import\([^"']/);
    const gateway = readFileSync(join(ROOT, "services/piece-runtime/src/gateway.mjs"), "utf8");
    assert.doesNotMatch(gateway, /authorization|bearer|credential|docker\.sock/i);
    const lock = readFileSync(join(ROOT, "services/piece-runtime/package-lock.json"), "utf8");
    assert.match(lock, /sha512-P3svTd\//);
  });
});
