import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";

import {
  createAdapterRegistry,
} from "../services/piece-runtime/src/adapter-registry.mjs";
import {
  createPieceBuildRegistry,
  HUBSPOT_0_8_10_BUILD,
  REVIEWED_PIECE_BUILDS,
} from "../services/piece-runtime/src/build-registry.mjs";
import {
  buildInvocationPlan,
  executeWithContainerEngine,
  PieceContainerEngine,
} from "../services/piece-runtime/src/container-engine.mjs";
import { resolveManifestDestination } from "../services/piece-runtime/src/dns-policy.mjs";
import { PIECE_ERROR_CODES } from "../services/piece-runtime/src/errors.mjs";
import {
  approvedDestinationForHostname,
  gatewayConnectionEvidence,
} from "../services/piece-runtime/src/gateway-evidence.mjs";
import { isSafePublicAddress } from "../services/piece-runtime/src/ip-policy.mjs";
import {
  createManifestRegistry,
  HUBSPOT_GET_CONTACT_MANIFEST,
  REVIEWED_MANIFESTS,
} from "../services/piece-runtime/src/manifest-registry.mjs";
import { validateInvocationRequest } from "../services/piece-runtime/src/protocol.mjs";
import { loadReviewedAction } from "../services/piece-runtime/src/piece-loader.mjs";
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
  buildId: "crazyloops-test-piece-1_0_0",
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

const SYNTHETIC_BUILD = {
  buildId: "crazyloops-test-piece-1_0_0",
  packageName: "@crazyloops/test-piece",
  packageVersion: "1.0.0-test",
  npmIntegrity: "sha512-test-fixture",
  upstreamSourceCommit: "0000000000000000000000000000000000000000",
  sandboxImage: "crazyloops/piece-runtime-fixture:1.0.0-test",
  actions: {
    "echo-read": {
      classification: "READ",
      resolve: async () => {
        const loaded = await import("./fixtures/essential-fifty-synthetic-piece.mjs");
        return loaded.syntheticPiece.actions()["echo-read"];
      },
    },
  },
};

function hubspotBuildFor(resolveAction: () => Promise<unknown>) {
  return createPieceBuildRegistry([{
    ...HUBSPOT_0_8_10_BUILD,
    actions: {
      "get-contact": { classification: "READ", resolve: resolveAction },
    },
  }]);
}

const syntheticBuilds = createPieceBuildRegistry([SYNTHETIC_BUILD]);
const syntheticManifests = createManifestRegistry([SYNTHETIC_MANIFEST], syntheticBuilds);
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
    const build = REVIEWED_PIECE_BUILDS.getForManifest(manifest);
    assert.equal(manifest.buildId, "activepieces-hubspot-0_8_10");
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
    assert.equal(build.sandboxImage, "crazyloops/piece-runtime-hubspot:0.8.10-step5a");
    assert.equal(build.packageName, manifest.piecePackage);
    assert.equal(build.packageVersion, manifest.pieceVersion);
    assert.equal(build.npmIntegrity, manifest.npmIntegrity);
    assert.throws(() => { (manifest.destinations[0] as { hostname: string }).hostname = "attacker.example"; });
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), destinations: [{ hostname: "*.example.com", port: 443, protocol: "tls" }] }]));
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), authProjection: "request_expression" }]));
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), resourceLimits: { ...structuredClone(manifest.resourceLimits), sandbox: { ...structuredClone(manifest.resourceLimits.sandbox), dockerSocket: true } } }]));
    assert.throws(() => createManifestRegistry([{ ...structuredClone(manifest), buildId: "unknown-reviewed-build" }]));
  });

  test("real loader resolves the HubSpot action through reviewed static build metadata", async () => {
    const action = await loadReviewedAction(HUBSPOT_GET_CONTACT_MANIFEST, REVIEWED_PIECE_BUILDS);
    assert.equal(action.name, "get-contact");
    assert.equal(action.classification, "READ");
    assert.equal(typeof action.run, "function");
  });

  test("request schema contains business data only and rejects every metadata override", async () => {
    for (const key of ["buildId", "sandboxImage", "image", "resolver", "piecePackage", "pieceVersion", "npmIntegrity", "actionId", "hostname", "port", "url", "method", "authProjection", "outputMapper", "resourceLimits"]) {
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
    const builds = hubspotBuildFor(async () => {
      loads += 1;
      throw new Error("must not load");
    });
    for (const overrides of [{ capabilityId: "salesforce.read" }, { capabilityVersion: 2 }]) {
      const result = await executeReviewedPiece(
        { request: request(overrides), credential: Buffer.from("synthetic-credential") },
        { builds },
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
        builds: hubspotBuildFor(async () => ({
          name: "get-contact",
          classification: "READ",
          async run(context: Record<string, unknown>) {
            attempts += 1;
            captured = context;
            return { id: "contact-123", properties: { firstname: "Casey" }, archived: false, ignored: canary };
          },
        })),
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
        builds: syntheticBuilds,
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { echo: "hello" });
    const syntheticPlan = buildInvocationPlan(
      request({ capabilityId: "fixture.echo_read", input: { message: "hello" } }),
      syntheticManifests,
      syntheticBuilds,
    );
    assert.equal(syntheticPlan.buildId, "crazyloops-test-piece-1_0_0");
    assert.equal(syntheticPlan.images.sandbox, "crazyloops/piece-runtime-fixture:1.0.0-test");
    assert.ok(credential.every((byte) => byte === 0));
  });

  test("WRITE manifests are denied before loading or running an action", async () => {
    let loaded = false;
    const builds = createPieceBuildRegistry([{
      ...SYNTHETIC_BUILD,
      actions: {
        "write-action": {
          classification: "WRITE",
          resolve: async () => { loaded = true; return {}; },
        },
      },
    }]);
    const manifests = createManifestRegistry([WRITE_MANIFEST], builds);
    const result = await executeReviewedPiece(
      {
        request: request({ capabilityId: "fixture.write", input: { message: "write" } }),
        credential: Buffer.from("fixture-secret"),
      },
      { manifests, adapters: syntheticAdapters, builds },
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
      const builds = hubspotBuildFor(async () => action);
      const result = await executeReviewedPiece(
        { request: request(), credential: Buffer.from("valid") },
        { builds },
      );
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, "PIECE_ACTION_NOT_ALLOWED");
    }
  });

  test("malformed/oversized input and malformed/oversized credentials fail closed", async () => {
    let loads = 0;
    const builds = hubspotBuildFor(async () => { loads += 1; throw new Error("must not load"); });
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
      const result = await executeReviewedPiece(invocation, { builds });
      assert.equal(result.ok, false);
      assert.ok(["PIECE_INVALID_INPUT", "PIECE_INVALID_CREDENTIAL"].includes(result.errorCode));
    }
    assert.equal(loads, 0);
  });

  test("provider failures, timeout, malformed output, and output ceiling use bounded errors", async () => {
    const scenarios = [
      [{ status: 401, secret: "provider body" }, "PIECE_AUTH_FAILED", false],
      [{ status: 429, secret: "provider body" }, "PIECE_RATE_LIMITED", true],
      [{ status: 503, secret: "provider body" }, "PIECE_PROVIDER_UNAVAILABLE", true],
      [{ code: 401, body: { secret: "provider body" } }, "PIECE_AUTH_FAILED", false],
      [{ code: 403, body: { secret: "provider body" } }, "PIECE_AUTH_FAILED", false],
      [{ code: 429, body: { secret: "provider body" } }, "PIECE_RATE_LIMITED", true],
      [{ code: 503, body: { secret: "provider body" } }, "PIECE_PROVIDER_UNAVAILABLE", true],
      [{ code: "401", body: { secret: "provider body" } }, "PIECE_RUNTIME_FAILED", false],
      [{ code: 99, body: { secret: "provider body" } }, "PIECE_RUNTIME_FAILED", false],
      [{ code: 600, body: { secret: "provider body" } }, "PIECE_RUNTIME_FAILED", false],
      [{ code: "ETIMEDOUT", body: { secret: "provider body" } }, "PIECE_TIMEOUT", true],
      [{ code: "ENOTFOUND", body: { secret: "provider body" } }, "PIECE_EGRESS_DENIED", false],
    ] as const;
    for (const [thrown, code, retryable] of scenarios) {
      const logs: unknown[] = [];
      const result = await executeReviewedPiece(
        { request: request(), credential: Buffer.from("valid") },
        { logger: (event: unknown) => logs.push(event), builds: hubspotBuildFor(async () => ({ name: "get-contact", classification: "READ", run: async () => { throw thrown; } })) },
      );
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, code);
      assert.equal(result.retryable, retryable);
      assert.equal(JSON.stringify({ result, logs }).includes("provider body"), false);
    }

    const timeoutManifest = structuredClone(HUBSPOT_GET_CONTACT_MANIFEST);
    timeoutManifest.resourceLimits.executionTimeoutMs = 10;
    const timeoutBuilds = hubspotBuildFor(async () => ({ name: "get-contact", classification: "READ", run: async () => new Promise(() => {}) }));
    const timeout = await executeReviewedPiece(
      { request: request(), credential: Buffer.from("valid") },
      { manifests: createManifestRegistry([timeoutManifest], timeoutBuilds), builds: timeoutBuilds },
    );
    assert.equal(timeout.ok, false);
    assert.equal(timeout.errorCode, "PIECE_TIMEOUT");

    const malformed = await executeReviewedPiece(
      { request: request(), credential: Buffer.from("valid") },
      { builds: hubspotBuildFor(async () => ({ name: "get-contact", classification: "READ", run: async () => ({ unexpected: true }) })) },
    );
    assert.equal(malformed.ok, false);
    assert.equal(malformed.errorCode, "PIECE_RESPONSE_INVALID");

    const oversized = await executeReviewedPiece(
      { request: request(), credential: Buffer.from("valid") },
      { builds: hubspotBuildFor(async () => ({ name: "get-contact", classification: "READ", run: async () => ({ id: "contact", properties: { huge: "x".repeat(200_000) } }) })) },
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
    await assert.rejects(
      resolveManifestDestination(destination, {
        resolve4: async () => [{ address: "10.252.0.2", ttl: 60 }],
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
    assert.deepEqual(plan.sandbox.canonicalHostMappings, [{
      hostname: "api.hubapi.com",
      target: "gateway_internal_ip",
      gatewayName: plan.names.gateway,
    }]);
    assert.deepEqual(plan.gateway.internalAliases, [plan.names.gateway]);
    assert.deepEqual(plan.gateway.providerHostAliases, []);
    assert.deepEqual(plan.gateway.resolverHostnames, ["api.hubapi.com"]);
    assert.equal(plan.gateway.internalAliases.includes("api.hubapi.com"), false);
    assert.equal(plan.sandbox.canonicalHostMappings.some(({ hostname }: { hostname: string }) => hostname === "redirect.example"), false);
  });

  test("gateway connection evidence retains only an approved reviewed SNI destination", () => {
    const spoofedBeforeApproval = {
      requestId: "request-123",
      capabilityId: HUBSPOT_GET_CONTACT_MANIFEST.capabilityId,
      approvedDestination: null,
      hostname: "api.hubapi.com",
      upstreamBytes: 0,
      downstreamBytes: 0,
      outcome: "PIECE_EGRESS_DENIED",
    };
    const beforeApproval = gatewayConnectionEvidence(spoofedBeforeApproval);
    assert.equal(beforeApproval.hostname, null);

    assert.equal(approvedDestinationForHostname(HUBSPOT_GET_CONTACT_MANIFEST, "wrong.example"), null);
    assert.equal(approvedDestinationForHostname(HUBSPOT_GET_CONTACT_MANIFEST, undefined), null);

    const approvedDestination = approvedDestinationForHostname(HUBSPOT_GET_CONTACT_MANIFEST, "api.hubapi.com");
    assert.equal(approvedDestination, HUBSPOT_GET_CONTACT_MANIFEST.destinations[0]);
    const normalClientEnd = gatewayConnectionEvidence({
      requestId: "request-123",
      capabilityId: HUBSPOT_GET_CONTACT_MANIFEST.capabilityId,
      approvedDestination,
      upstreamBytes: 517,
      downstreamBytes: 2048,
      outcome: "PIECE_GATEWAY_SUCCEEDED",
    });
    assert.equal(normalClientEnd.hostname, "api.hubapi.com");
    assert.equal(normalClientEnd.port, 443);
    assert.equal(normalClientEnd.outcome, "PIECE_GATEWAY_SUCCEEDED");

    const gatewayDockerfile = readFileSync(join(ROOT, "services/piece-runtime/Dockerfile.gateway"), "utf8");
    assert.match(gatewayDockerfile, /src\/gateway-evidence\.mjs/);
  });

  test("container plan preserves the accepted sandbox/gateway security policy", () => {
    const plan = buildInvocationPlan(request());
    assert.equal(plan.sandbox.internalOnlyNetwork, true);
    assert.equal(plan.buildId, "activepieces-hubspot-0_8_10");
    assert.equal(plan.images.sandbox, "crazyloops/piece-runtime-hubspot:0.8.10-step5a");
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
        builds: hubspotBuildFor(async () => ({ name: "get-contact", classification: "READ", run: async () => ({ id: "contact-123", properties: {}, archived: false }) })),
      },
    );
    const plan = buildInvocationPlan(request());
    const report = { result, logs, inspect: plan, imageHistory: readFileSync(join(ROOT, "services/piece-runtime/Dockerfile.sandbox"), "utf8") };
    assert.equal(JSON.stringify(report).includes(canary), false);
    assert.ok(credential.every((byte) => byte === 0));
  });

  test("owner-run host harness covers real Docker boundaries without product deployment", () => {
    const harness = readFileSync(join(ROOT, "scripts/e50-step5a-host-acceptance.sh"), "utf8");
    assert.match(harness, /EXPECTED_BASE='07b236ca99b5044600fe2c9b3e9ac5966397b2d4'/);
    assert.match(harness, /codex\/e50-piece-runtime/);
    assert.match(harness, /git status --porcelain/);
    assert.match(harness, /git diff --name-only "\$EXPECTED_BASE\.\.HEAD"/);
    assert.match(harness, /git rev-parse origin\/main/);
    assert.match(harness, /node:24\.8\.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85/);
    assert.match(harness, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
    assert.match(harness, /installed\.version !== build\.packageVersion/);
    assert.match(harness, /installed\.integrity !== build\.npmIntegrity/);
    assert.match(harness, /--no-cache --label "\$LABEL"/);
    assert.match(harness, /docker network create --internal/);
    assert.match(harness, /docker network create --label "\$LABEL" "\$EGRESS_NETWORK"/);
    assert.match(harness, /--network "\$INTERNAL_NETWORK"/);
    assert.match(harness, /--add-host "api\.hubapi\.com:\$GATEWAY_INTERNAL_IP"/);
    assert.match(harness, /--alias "\$GATEWAY" "\$INTERNAL_NETWORK" "\$GATEWAY"/);
    assert.match(harness, /! grep -q "api\.hubapi\.com" \/etc\/hosts/);
    assert.doesNotMatch(harness, /node:dns\/promises|lookup\("api\.hubapi\.com"/);
    assert.match(harness, /tls-probe\.mjs canonical/);
    assert.match(harness, /"authorized":true/);
    assert.match(harness, /"applicationBytesSent":0/);
    assert.match(harness, /event\.event === 'piece_gateway_dns'/);
    assert.match(harness, /event\.capabilityId !== 'hubspot\.get_contact'/);
    assert.match(harness, /event\.hostname !== 'api\.hubapi\.com'/);
    assert.match(harness, /event\.port !== 443/);
    assert.match(harness, /event\.outcome !== 'SAFE'/);
    assert.match(harness, /event\.answers\.length === 0/);
    assert.match(harness, /event\.answers\.every\(\(answer\) => answer\?\.classification === 'SAFE'\)/);
    assert.match(harness, /event\.event === 'piece_gateway_connection'/);
    assert.match(harness, /event\.hostname === 'api\.hubapi\.com'/);
    assert.match(harness, /event\.outcome === 'PIECE_GATEWAY_SUCCEEDED'/);
    assert.match(harness, /--read-only/);
    assert.match(harness, /--tmpfs \/tmp:rw,noexec,nosuid,nodev,size=4m/);
    assert.match(harness, /--cap-drop=ALL/);
    assert.match(harness, /--security-opt=no-new-privileges/);
    assert.match(harness, /--pids-limit=16/);
    assert.match(harness, /--memory=134217728/);
    assert.match(harness, /--memory-swap=134217728/);
    assert.match(harness, /--cpus=0\.5/);
    assert.match(harness, /--memory=67108864 --memory-swap=67108864 --cpus=0\.25/);
    assert.match(harness, /--ulimit=nofile=64:64/);
    assert.match(harness, /runtime\.capabilities !== '0000000000000000'/);
    assert.match(harness, /runtime\.seccomp !== '2'/);
    assert.match(harness, /runtime\.pidsMax !== '16'/);
    assert.match(harness, /Object\.keys\(inspect\.NetworkSettings\.Networks\)\.length !== 2/);
    assert.match(harness, /docker run --detach --name "\$OOM_NAME"/);
    assert.match(harness, /timeout 25 docker wait "\$OOM_NAME"/);
    assert.match(harness, /kill_wait_remove_probe "\$OOM_NAME"/);
    assert.match(harness, /fail 'OOM probe did not terminate within its bounded wait\.'/);
    assert.match(harness, /docker run --detach --name "\$CPU_NAME"/);
    assert.match(harness, /timeout 5 docker wait "\$CPU_NAME"/);
    assert.match(harness, /case "\$cpu_wait_status" in[\s\S]*124\)[\s\S]*kill_wait_remove_probe "\$CPU_NAME"/);
    assert.match(harness, /fail 'CPU runaway probe unexpectedly exited before timeout\.'/);
    assert.doesNotMatch(harness, /timeout (?:5|25) docker run/);
    assert.match(harness, /docker kill "\$name"/);
    assert.match(harness, /docker wait "\$name"/);
    assert.match(harness, /docker rm "\$name"/);
    assert.match(harness, /docker inspect "\$name"/);
    for (const marker of [
      "unsupported", "wrong-version", "worker-large",
      "worker-large-credential", "negative-runtime", "filesystem", "child", "network",
      "wrong-sni", "missing-sni", "wrong-port", "crash", "oom", "cpu",
      "concurrent-one", "concurrent-two", "worker-crossover", "temp-first", "temp-second",
    ]) assert.match(harness, new RegExp(marker));
    assert.match(harness, /for override in buildId piecePackage pieceVersion actionId hostname port authProjection sandboxImage/);
    assert.match(harness, /PROTECTED=\(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis\)/);
    assert.match(harness, /snapshot_protected "\$PROTECTED_BEFORE"/);
    assert.match(harness, /cmp -s "\$PROTECTED_BEFORE" "\$PROTECTED_AFTER"/);
    assert.match(harness, /Content-Type: application\/json/);
    assert.match(harness, /expected 401/);
    assert.match(harness, /docker exec redis redis-cli PING/);
    assert.match(harness, /trap cleanup EXIT INT TERM/);
    assert.match(harness, /credentialBase64/);
    assert.match(harness, /printf '%s' "\$envelope" \| docker run/);
    assert.match(harness, /TOKEN\/CREDENTIAL PLAINTEXT OCCURRENCES=0/);
    assert.match(harness, /grep -Fq "\$CANARY" "\$SURFACE_FILE"/);
    assert.match(harness, /docker image inspect "\$SANDBOX_IMAGE" "\$GATEWAY_IMAGE" "\$ACCEPTANCE_IMAGE"/);
    assert.match(harness, /docker history --no-trunc "\$SANDBOX_IMAGE"/);
    assert.match(harness, /STEP5A_CONTAINERS.*count_labelled containers/);
    assert.match(harness, /STEP5A_NETWORKS.*count_labelled networks/);
    assert.match(harness, /STEP5A_IMAGES.*count_labelled images/);
    assert.match(harness, /for image in "\$ACCEPTANCE_IMAGE" "\$GATEWAY_IMAGE" "\$SANDBOX_IMAGE"/);
    assert.match(harness, /docker image rm -f/);
    assert.doesNotMatch(harness, /--env[^\n]*(credential|secret|token)/i);
    assert.doesNotMatch(harness, /docker\.sock|--privileged|flow-mind-beta|crazy-loops\.com|vercel deploy|git push/i);
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
    const builds = readFileSync(join(ROOT, "services/piece-runtime/src/build-registry.mjs"), "utf8");
    assert.match(loader, /builds\.getForManifest\(manifest\)/);
    assert.match(builds, /import\("@activepieces\/piece-hubspot"\)/);
    assert.doesNotMatch(builds, /import\([^"']/);
    const gateway = readFileSync(join(ROOT, "services/piece-runtime/src/gateway.mjs"), "utf8");
    assert.doesNotMatch(gateway, /authorization|bearer|credential|docker\.sock/i);
    const lock = readFileSync(join(ROOT, "services/piece-runtime/package-lock.json"), "utf8");
    assert.match(lock, /sha512-P3svTd\//);
  });
});
