import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";

import { buildInvocationPlan } from "../services/piece-runtime/src/container-engine.mjs";
import {
  EGRESS_BROKER_CONTAINER_NAME,
  EGRESS_BROKER_CONTROL_VOLUME,
  EGRESS_BROKER_IMAGE,
  EGRESS_BROKER_LABELS,
  EGRESS_BROKER_MAX_CONTROL_BYTES,
  EGRESS_BROKER_MAX_POLICY_TTL_MS,
  EGRESS_BROKER_RUNTIME_SPEC,
  EGRESS_BROKER_SOCKET_PATH,
} from "../services/piece-runtime/src/egress-broker-constants.mjs";
import { EgressBrokerPolicyStore, startEgressBrokerControlServer, validateBrokerControlMessage, validateEgressBrokerSocketPath } from "../services/piece-runtime/src/egress-broker-control.mjs";
import { handleBrokerClient } from "../services/piece-runtime/src/egress-broker.mjs";
import { validatedBrokerContainerName } from "../services/piece-runtime/src/docker-piece-container-engine.mjs";
import { REVIEWED_MANIFESTS } from "../services/piece-runtime/src/manifest-registry.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ADDRESS = "172.29.0.2";
const BASELINE = "172.17.0.2";

function request(id = "broker-test-request") {
  return {
    protocolVersion: 1, requestId: id, executionId: `execution-${id}`,
    capabilityId: "hubspot.get_contact", capabilityVersion: 1, mode: "TEST",
    idempotencyKey: `idempotency-${id}`, input: { contactId: "synthetic-contact", properties: ["firstname"] },
  };
}

function register(invocationId = "0123456789abcdef", address = ADDRESS, extras = {}) {
  return {
    protocolVersion: 1, operation: "register", invocationId, requestId: "broker-test-request",
    capabilityId: "hubspot.get_contact", capabilityVersion: 1, mode: "TEST", brokerLocalAddress: address,
    ...extras,
  };
}

function resolved(hostname = "api.hubapi.com") {
  return { hostname, port: 443, pinnedAddress: "8.8.8.8", family: 4, evidence: [{ family: 4, ttl: 60, classification: "SAFE" }] };
}

function store(options: Record<string, unknown> = {}) {
  return new EgressBrokerPolicyStore({
    baselineAddresses: new Set([BASELINE]), listInterfaceAddresses: () => new Set([BASELINE, ADDRESS]),
    resolveDestination: async (destination: { hostname: string }) => resolved(destination.hostname), ...options,
  });
}

function tlsHello(hostname = "api.hubapi.com") {
  const name = Buffer.from(hostname, "ascii");
  const list = Buffer.concat([Buffer.from([0, (name.length >> 8) & 0xff, name.length & 0xff]), name]);
  const extensionData = Buffer.concat([Buffer.from([(list.length >> 8) & 0xff, list.length & 0xff]), list]);
  const extension = Buffer.concat([Buffer.from([0, 0, (extensionData.length >> 8) & 0xff, extensionData.length & 0xff]), extensionData]);
  const body = Buffer.concat([
    Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]), Buffer.from([(extension.length >> 8) & 0xff, extension.length & 0xff]), extension,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1, (handshake.length >> 8) & 0xff, handshake.length & 0xff]), handshake]);
}

class FakeClientSocket extends EventEmitter {
  localAddress = ADDRESS;
  writes: Buffer[] = [];
  destroyed = false;
  paused = false;
  write(value: Buffer) { this.writes.push(Buffer.from(value)); return true; }
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
  destroy() { this.destroyed = true; return this; }
}

class FakeProviderSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  idleTimeoutMs: number | null = null;
  idleHandler: (() => void) | null = null;
  write(value: Buffer) { this.writes.push(Buffer.from(value)); return true; }
  destroy() { this.destroyed = true; return this; }
  setTimeout(delay: number, handler: () => void) { this.idleTimeoutMs = delay; this.idleHandler = handler; return this; }
}

class FakeTimers {
  timers: Array<{ delay: number; callback: () => void; cleared: boolean }> = [];
  set = (callback: () => void, delay: number) => {
    const timer = { delay, callback, cleared: false };
    this.timers.push(timer);
    return timer;
  };
  clear = (timer?: { cleared: boolean }) => { if (timer) timer.cleared = true; };
  fire(delay: number) {
    const timer = this.timers.find((candidate) => candidate.delay === delay && !candidate.cleared);
    assert.ok(timer, `missing timer ${delay}`);
    timer.cleared = true;
    timer.callback();
  }
}

function brokerDataHarness(options: { acceptedHostname?: string; limits?: Record<string, number> } = {}) {
  const client = new FakeClientSocket();
  const provider = new FakeProviderSocket();
  const timers = new FakeTimers();
  const events: Array<Record<string, unknown>> = [];
  const authorizeCalls: Array<{ localAddress: string; hostname: string }> = [];
  const providerCalls: Array<Record<string, unknown>> = [];
  let releases = 0;
  const limits = {
    maximumProviderUpstreamBytes: 32 * 1024,
    maximumProviderDownstreamBytes: 32 * 1024,
    connectTimeoutMs: 101,
    idleTimeoutMs: 202,
    lifetimeTimeoutMs: 303,
    simultaneousConnections: 2,
    ...options.limits,
  };
  const policyStore = {
    authorize(localAddress: string, hostname: string) {
      authorizeCalls.push({ localAddress, hostname });
      if (hostname !== (options.acceptedHostname ?? "api.hubapi.com")) throw new Error("denied");
      return {
        invocationId: "0123456789abcdef", requestId: "broker-test-request", capabilityId: "hubspot.get_contact",
        destination: { hostname: "api.hubapi.com", pinnedAddress: "203.0.113.10", port: 443, family: 4 },
        limits,
        release() { releases += 1; },
      };
    },
  };
  handleBrokerClient(client, {
    policyStore,
    connectProvider(configuration: Record<string, unknown>) { providerCalls.push(configuration); return provider; },
    logger(event: Record<string, unknown>) { events.push(event); },
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  return { client, provider, timers, events, authorizeCalls, providerCalls, releases: () => releases };
}

function socketExchange(socketPath: string, payload: Buffer) {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const socket = connectSocket(socketPath);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolvePromise(Buffer.concat(chunks)));
    socket.once("error", reject);
  });
}

describe("Essential 50 Step 5B.1 long-lived egress broker", () => {
  test("service identity and runtime hardening are exact and credential blind", () => {
    assert.equal(EGRESS_BROKER_CONTAINER_NAME, "crazyloops-piece-egress-broker");
    assert.equal(EGRESS_BROKER_IMAGE, "crazyloops/piece-egress-broker:step5b1");
    assert.deepEqual(EGRESS_BROKER_LABELS, { "crazyloops.runtime": "piece-egress-broker-v1", "crazyloops.resource": "service" });
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.user, "65532:65532");
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.readOnlyRoot, true);
    assert.deepEqual(EGRESS_BROKER_RUNTIME_SPEC.capDrop, ["ALL"]);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.noNewPrivileges, true);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.privileged, false);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.dockerSocket, false);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.credentialAccess, false);
    assert.deepEqual(EGRESS_BROKER_RUNTIME_SPEC.publishedPorts, []);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.pidsLimit, 32);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.memoryBytes, 128 * 1024 * 1024);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.cpus, 0.5);
    assert.equal(EGRESS_BROKER_RUNTIME_SPEC.nofile, "256:256");
  });

  test("control plane is exact UDS-only, bounded, and rejects malformed schemas", () => {
    assert.equal(EGRESS_BROKER_SOCKET_PATH, "/run/crazyloops-egress-control/broker.sock");
    assert.equal(EGRESS_BROKER_CONTROL_VOLUME, "crazyloops-piece-egress-control");
    assert.equal(EGRESS_BROKER_MAX_CONTROL_BYTES, 16 * 1024);
    assert.equal(validateEgressBrokerSocketPath(EGRESS_BROKER_SOCKET_PATH), EGRESS_BROKER_SOCKET_PATH);
    for (const path of ["broker.sock", "/tmp/broker.sock", "/run/crazyloops-egress-control/other.sock"]) assert.throws(() => validateEgressBrokerSocketPath(path));
    for (const value of [null, [], {}, { protocolVersion: 2, operation: "health" }, { protocolVersion: 1, operation: "unknown" }, { protocolVersion: 1, operation: "health", extra: true }]) assert.throws(() => validateBrokerControlMessage(value));
  });

  test("register schema rejects bad identities, arbitrary fields, hostnames, modes, and addresses", () => {
    assert.equal(validateBrokerControlMessage(register()).operation, "register");
    for (const bad of [
      register("bad id"), register("0123456789abcdef", "not-an-ip"), register("0123456789abcdef", ADDRESS, { hostname: "evil.example" }),
      { ...register(), mode: "LIVE" }, { ...register(), capabilityId: "bad capability" }, { ...register(), capabilityVersion: 0 },
    ]) assert.throws(() => validateBrokerControlMessage(bad));
  });

  test("registration derives the exact reviewed destination and never returns its pinned IP", async () => {
    let reviewed: unknown = null;
    const policies = store({ resolveDestination: async (destination: unknown) => { reviewed = destination; return resolved(); } });
    const result = await policies.register(register());
    assert.deepEqual(reviewed, REVIEWED_MANIFESTS.get("hubspot.get_contact", 1).destinations[0]);
    assert.equal(result.destinations[0].hostname, "api.hubapi.com");
    assert.equal(JSON.stringify(result).includes("8.8.8.8"), false);
    assert.equal(JSON.stringify(result).includes("pinnedAddress"), false);
  });

  test("registration acknowledgement is an exact bounded safe schema", async () => {
    const now = 25_000;
    const result = await store({ now: () => now }).register(register());
    assert.deepEqual(Object.keys(result).sort(), ["destinations", "expiresAt", "invocationId", "ok", "operation", "protocolVersion"]);
    assert.equal(result.expiresAt > now, true);
    assert.equal(result.expiresAt - now <= EGRESS_BROKER_MAX_POLICY_TTL_MS, true);
    assert.deepEqual(Object.keys(result.destinations[0]).sort(), ["evidence", "hostname", "port"]);
    assert.deepEqual(Object.keys(result.destinations[0].evidence[0]).sort(), ["classification", "family", "ttl"]);
  });

  test("unsafe, malformed, and unknown DNS outcomes fail registration closed", async () => {
    for (const error of [new Error("unsafe"), new TypeError("malformed"), Object.assign(new Error("dns"), { code: "EAI_AGAIN" })]) {
      await assert.rejects(store({ resolveDestination: async () => { throw error; } }).register(register()));
    }
  });

  test("registration requires a current non-baseline broker interface", async () => {
    await assert.rejects(store().register(register("0123456789abcdef", "172.30.0.9")));
    await assert.rejects(store().register(register("0123456789abcdef", BASELINE)));
  });

  test("policy TTL is bounded, duplicate cross-invocation registration fails, and revoke is immediate", async () => {
    const now = 10_000;
    const policies = store({ now: () => now });
    const result = await policies.register(register());
    assert.ok(result.expiresAt - now <= EGRESS_BROKER_MAX_POLICY_TTL_MS);
    await assert.rejects(policies.register(register("fedcba9876543210")));
    assert.equal(policies.revoke({ protocolVersion: 1, operation: "revoke", invocationId: "0123456789abcdef", brokerLocalAddress: ADDRESS }).ok, true);
    assert.throws(() => policies.authorize(ADDRESS, "api.hubapi.com"));
  });

  test("expired policy, absent interface policy, wrong SNI, suffix, wildcard, and literal IP all deny", async () => {
    let now = 1_000; const policies = store({ now: () => now }); await policies.register(register());
    for (const hostname of ["wrong.example", "sub.api.hubapi.com", "*.hubapi.com", "8.8.8.8"]) assert.throws(() => policies.authorize(ADDRESS, hostname));
    assert.throws(() => policies.authorize("172.29.0.3", "api.hubapi.com"));
    now += EGRESS_BROKER_MAX_POLICY_TTL_MS + 1;
    assert.throws(() => policies.authorize(ADDRESS, "api.hubapi.com"));
  });

  test("exact local interface plus exact SNI authorizes one reviewed pinned destination", async () => {
    const policies = store(); await policies.register(register());
    const lease = policies.authorize(ADDRESS, "api.hubapi.com");
    assert.equal(lease.destination.hostname, "api.hubapi.com");
    assert.equal(lease.destination.pinnedAddress, "8.8.8.8");
    assert.equal(lease.destination.port, 443);
    lease.release(); lease.release();
  });

  test("simultaneous-connection limit and cross-invocation local-address isolation are enforced", async () => {
    const policies = store(); await policies.register(register());
    const first = policies.authorize(ADDRESS, "api.hubapi.com"); const second = policies.authorize(ADDRESS, "api.hubapi.com");
    assert.throws(() => policies.authorize(ADDRESS, "api.hubapi.com"));
    assert.throws(() => policies.authorize("172.29.0.3", "api.hubapi.com"));
    first.release(); second.release();
  });

  test("active plan creates one sandbox and one internal network with broker host mapping", () => {
    const plan = buildInvocationPlan(request());
    assert.deepEqual(Object.keys(plan.names).sort(), ["internalNetwork", "sandbox"]);
    assert.deepEqual(plan.sandbox.canonicalHostMappings, [{ hostname: "api.hubapi.com", target: "egress_broker_internal_ip" }]);
    assert.equal(plan.broker.containerName, EGRESS_BROKER_CONTAINER_NAME);
    assert.equal(JSON.stringify(plan).includes("cl-piece-gateway"), false);
    assert.equal(JSON.stringify(plan).includes("cl-piece-egress"), false);
  });

  test("active engine verifies, attaches, registers, then starts sandbox and cleanup revokes/detaches without deleting broker", () => {
    const source = readFileSync(resolve(ROOT, "services/piece-runtime/src/docker-piece-container-engine.mjs"), "utf8");
    const verify = source.indexOf("await this.verifyBroker()");
    const network = source.indexOf("createNetwork(", verify);
    const attach = source.indexOf("connectNetwork(", network);
    const registerIndex = source.indexOf("brokerClient.register", attach);
    const sandbox = source.indexOf("createContainer(plan.names.sandbox", registerIndex);
    assert.ok(verify >= 0 && verify < network && network < attach && attach < registerIndex && registerIndex < sandbox);
    assert.match(source, /brokerClient\.revoke/);
    assert.match(source, /disconnectNetwork/);
    assert.doesNotMatch(source, /createContainer\(plan\.names\.gateway|names\.egressNetwork|removeContainer\(this\.brokerContainerName/);
  });

  test("broker uses one startup Resolver and relays encrypted TCP without terminating TLS or reconnecting", () => {
    const source = readFileSync(resolve(ROOT, "services/piece-runtime/src/egress-broker.mjs"), "utf8");
    assert.match(source, /resolver = new Resolver\(\)/);
    assert.match(source, /resolver\.resolve4/); assert.match(source, /resolver\.resolve6/);
    assert.doesNotMatch(source, /setServers|8\.8\.8\.8|1\.1\.1\.1|createSecureContext|tls\.createServer|Authorization/);
    assert.equal((source.match(/connectProvider\(/g) ?? []).length, 1);
    assert.match(source, /maximumProviderUpstreamBytes/); assert.match(source, /maximumProviderDownstreamBytes/);
    assert.match(source, /connectTimeoutMs/); assert.match(source, /idleTimeoutMs/); assert.match(source, /lifetimeTimeoutMs/);
  });

  test("dynamic exact SNI authorization uses one pinned numeric provider connection and reuses it", () => {
    const harness = brokerDataHarness();
    const hello = tlsHello();
    harness.client.emit("data", hello);
    assert.deepEqual(harness.authorizeCalls, [{ localAddress: ADDRESS, hostname: "api.hubapi.com" }]);
    assert.deepEqual(harness.providerCalls, [{ host: "203.0.113.10", port: 443, family: 4 }]);
    harness.provider.emit("connect");
    assert.deepEqual(harness.provider.writes, [hello]);
    harness.client.emit("data", Buffer.from("encrypted-application-bytes"));
    assert.equal(harness.providerCalls.length, 1);
    assert.equal(harness.provider.writes.length, 2);
    harness.provider.emit("end");
    assert.equal(harness.releases(), 1);
    assert.equal(harness.events.at(-1)?.outcome, "PIECE_BROKER_SUCCEEDED");
  });

  test("dynamic wrong SNI and malformed ClientHello deny without provider connection", () => {
    const wrong = brokerDataHarness();
    wrong.client.emit("data", tlsHello("wrong.example"));
    assert.equal(wrong.authorizeCalls.length, 1);
    assert.equal(wrong.providerCalls.length, 0);
    assert.equal(wrong.events.at(-1)?.outcome, "PIECE_EGRESS_DENIED");
    assert.equal(wrong.releases(), 0);

    const malformed = brokerDataHarness();
    malformed.client.emit("data", Buffer.from("not-a-tls-client-hello"));
    assert.equal(malformed.authorizeCalls.length, 0);
    assert.equal(malformed.providerCalls.length, 0);
    assert.equal(malformed.events.at(-1)?.outcome, "PIECE_EGRESS_DENIED");
    assert.equal(malformed.releases(), 0);
  });

  test("dynamic provider failure, upstream limit, and downstream limit are bounded with one release", () => {
    const providerFailure = brokerDataHarness();
    providerFailure.client.emit("data", tlsHello());
    providerFailure.provider.emit("error", new Error("provider unavailable"));
    providerFailure.provider.emit("end");
    providerFailure.client.emit("end");
    assert.equal(providerFailure.providerCalls.length, 1);
    assert.equal(providerFailure.releases(), 1);
    assert.equal(providerFailure.events.at(-1)?.outcome, "PIECE_PROVIDER_UNAVAILABLE");

    const hello = tlsHello();
    const upstream = brokerDataHarness({ limits: { maximumProviderUpstreamBytes: hello.length + 2 } });
    upstream.client.emit("data", hello);
    upstream.provider.emit("connect");
    upstream.client.emit("data", Buffer.from("too-large"));
    assert.equal(upstream.providerCalls.length, 1);
    assert.equal(upstream.releases(), 1);
    assert.equal(upstream.events.at(-1)?.outcome, "PIECE_EGRESS_DENIED");

    const downstream = brokerDataHarness({ limits: { maximumProviderDownstreamBytes: 2 } });
    downstream.client.emit("data", hello);
    downstream.provider.emit("connect");
    downstream.provider.emit("data", Buffer.from("too-large"));
    assert.equal(downstream.providerCalls.length, 1);
    assert.equal(downstream.releases(), 1);
    assert.equal(downstream.events.at(-1)?.outcome, "PIECE_RESPONSE_INVALID");
  });

  test("dynamic connect, idle, and lifetime timeouts release once and never reconnect", () => {
    const connectTimeout = brokerDataHarness();
    connectTimeout.client.emit("data", tlsHello());
    connectTimeout.timers.fire(101);
    assert.equal(connectTimeout.providerCalls.length, 1);
    assert.equal(connectTimeout.releases(), 1);
    assert.equal(connectTimeout.events.at(-1)?.outcome, "PIECE_TIMEOUT");

    const idleTimeout = brokerDataHarness();
    idleTimeout.client.emit("data", tlsHello());
    idleTimeout.provider.emit("connect");
    assert.equal(idleTimeout.provider.idleTimeoutMs, 202);
    idleTimeout.provider.idleHandler?.();
    assert.equal(idleTimeout.providerCalls.length, 1);
    assert.equal(idleTimeout.releases(), 1);
    assert.equal(idleTimeout.events.at(-1)?.outcome, "PIECE_TIMEOUT");

    const lifetimeTimeout = brokerDataHarness();
    lifetimeTimeout.client.emit("data", tlsHello());
    lifetimeTimeout.provider.emit("connect");
    lifetimeTimeout.timers.fire(303);
    assert.equal(lifetimeTimeout.providerCalls.length, 1);
    assert.equal(lifetimeTimeout.releases(), 1);
    assert.equal(lifetimeTimeout.events.at(-1)?.outcome, "PIECE_TIMEOUT");
  });

  test("real bounded control server accepts health and rejects oversized input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "crazyloops-egress-control-"));
    const socketPath = process.platform === "win32"
      ? `\\\\?\\pipe\\crazyloops-egress-control-${process.pid}-${Date.now()}`
      : join(directory, "broker.sock");
    const policyStore = store();
    const socketLifecycle = process.platform === "win32"
      ? { async claim() {}, secure() {}, remove() {} }
      : undefined;
    const control = await startEgressBrokerControlServer({
      policyStore,
      socketPath,
      socketPathValidator(value: string) { if (value !== socketPath) throw new Error("unexpected socket"); return value; },
      socketLifecycle,
    });
    try {
      const health = JSON.parse((await socketExchange(socketPath, Buffer.from('{"protocolVersion":1,"operation":"health"}\n'))).toString("utf8"));
      assert.equal(health.ok, true);
      assert.equal(health.operation, "health");
      assert.equal(health.status, "ready");

      const oversized = JSON.parse((await socketExchange(socketPath, Buffer.alloc(EGRESS_BROKER_MAX_CONTROL_BYTES + 1, 97))).toString("utf8"));
      assert.deepEqual(oversized, { ok: false, protocolVersion: 1, errorCode: "PIECE_EGRESS_DENIED" });
    } finally {
      await control.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("control, environment, logs, and image surfaces contain no credential channel", () => {
    const control = readFileSync(resolve(ROOT, "services/piece-runtime/src/egress-broker-control.mjs"), "utf8");
    const broker = readFileSync(resolve(ROOT, "services/piece-runtime/src/egress-broker.mjs"), "utf8");
    const dockerfile = readFileSync(resolve(ROOT, "services/piece-runtime/Dockerfile.egress-broker"), "utf8");
    for (const canary of ["credentialBase64", "access_token", "refresh_token", "client_secret", "docker.sock"]) {
      assert.equal(control.includes(canary), false); assert.equal(broker.includes(canary), false); assert.equal(dockerfile.includes(canary), false);
    }
  });

  test("historical gateway stays present but is not imported by the active engine", () => {
    const gateway = readFileSync(resolve(ROOT, "services/piece-runtime/src/gateway.mjs"), "utf8");
    const engine = readFileSync(resolve(ROOT, "services/piece-runtime/src/docker-piece-container-engine.mjs"), "utf8");
    assert.ok(gateway.length > 0); assert.doesNotMatch(engine, /from "\.\/gateway\.mjs"|gatewayContainerConfiguration|waitForGateway/);
    const manifest = REVIEWED_MANIFESTS.get("hubspot.get_contact", 1);
    assert.equal(manifest.retryPolicy.runtimeAttempts, 1); assert.equal(manifest.retryPolicy.safeAutomaticRetry, false);
  });

  test("broker image is non-root and contains only reviewed relay/control modules", () => {
    const dockerfile = readFileSync(resolve(ROOT, "services/piece-runtime/Dockerfile.egress-broker"), "utf8");
    assert.match(dockerfile, /USER 65532:65532/); assert.match(dockerfile, /ENTRYPOINT \["node", "\/piece-egress-broker\/src\/egress-broker\.mjs"\]/);
    assert.doesNotMatch(dockerfile, /connector-runner|supervisor\.mjs|worker\.mjs/);
  });

  test("supervisor configuration accepts only the exact broker identity and exact control path", () => {
    assert.equal(validatedBrokerContainerName(EGRESS_BROKER_CONTAINER_NAME), EGRESS_BROKER_CONTAINER_NAME);
    for (const value of ["", "other-broker", `${EGRESS_BROKER_CONTAINER_NAME}-evil`, "/crazyloops-piece-egress-broker"]) assert.throws(() => validatedBrokerContainerName(value));
    const supervisor = readFileSync(resolve(ROOT, "services/piece-runtime/src/supervisor.mjs"), "utf8");
    assert.match(supervisor, /PIECE_EGRESS_BROKER_CONTAINER_NAME/);
    assert.match(supervisor, /PIECE_EGRESS_BROKER_SOCKET_PATH/);
  });

  test("Docker authority adds only bounded network detach and no arbitrary execution API", () => {
    const docker = readFileSync(resolve(ROOT, "services/piece-runtime/src/docker-client.mjs"), "utf8");
    assert.match(docker, /async disconnectNetwork\(name, configuration\)/);
    assert.match(docker, /\/disconnect/);
    assert.doesNotMatch(docker, /execCreate|\/exec\//);
  });

  test("new owner-host harness is commit-gated, broker-first, topology-specific, and cleanup-scoped", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-egress-broker-host-acceptance.sh"), "utf8");
    assert.match(harness, /E50_EXPECTED_COMMIT/); assert.match(harness, /git status --porcelain/);
    assert.match(harness, /EXPECTED_ORIGIN_MAIN='20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7'/);
    assert.match(harness, /git fetch origin main codex\/e50-egress-broker/);
    assert.match(harness, /git rev-parse origin\/main.*EXPECTED_ORIGIN_MAIN/);
    assert.match(harness, /git rev-parse origin\/codex\/e50-egress-broker.*E50_EXPECTED_COMMIT/);
    assert.match(harness, /PROTECTED=\(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis\)/);
    assert.doesNotMatch(harness, /activepieces-worker(?:\s|\))/);
    const brokerStart = harness.indexOf('docker run -d --name "$BROKER_NAME"');
    const supervisorStart = harness.indexOf('docker run -d --name "$SUPERVISOR_NAME"');
    const fullCleanupTrap = harness.indexOf("trap 'cleanup $?' EXIT");
    assert.ok(harness.indexOf("git fetch origin main codex/e50-egress-broker") < fullCleanupTrap && fullCleanupTrap < brokerStart);
    assert.ok(brokerStart >= 0 && brokerStart < supervisorStart);
    assert.match(harness, /network none/); assert.match(harness, /crazyloops-piece-egress-control/);
    assert.match(harness, /docker pause "\$SANDBOX_NAME"/); assert.doesNotMatch(harness, /docker pause "\$BROKER_NAME"/);
    assert.match(harness, /cl-piece-gateway-/); assert.match(harness, /cl-piece-egress-/);
    assert.match(harness, /PIECE_AUTH_FAILED/); assert.match(harness, /upstreamConnections === 1/);
    assert.match(harness, /PROTECTED_SERVICES_UNCHANGED=PASS/);
    assert.doesNotMatch(harness, /docker compose|systemctl restart|vercel|supabase/);
    assert.match(harness, /HOST_UID="\$\(id -u\)"/);
    assert.match(harness, /HOST_GID="\$\(id -g\)"/);
    assert.doesNotMatch(harness, /\[\[ -S "\$SUPERVISOR_CONTROL\/piece-supervisor\.sock" \]\]/);
    const internalUdsProof = harness.indexOf("fs.lstatSync(\"/run/crazyloops-piece/piece-supervisor.sock\").isSocket()");
    const internalUdsMarker = harness.indexOf("SUPERVISOR_UDS_INTERNAL=PASS", internalUdsProof);
    const healthClient = harness.indexOf('docker run --rm -i --name "$SUPERVISOR_HEALTH_NAME"', internalUdsMarker);
    const healthPath = harness.indexOf("path: '/v1/health'", healthClient);
    const healthMarker = harness.indexOf("SUPERVISOR_UDS_HEALTH=PASS", healthPath);
    const canaryGeneration = harness.indexOf('CANARY="E50_STEP5B1_BROKER_', healthMarker);
    assert.ok(internalUdsProof >= 0 && internalUdsProof < internalUdsMarker && internalUdsMarker < healthClient);
    assert.ok(healthClient < healthPath && healthPath < healthMarker && healthMarker < canaryGeneration);
    const healthProof = harness.slice(healthClient, canaryGeneration);
    assert.match(healthProof, /--network none/);
    assert.match(healthProof, /--user=65532:65532/);
    assert.match(healthProof, /ok!==true/);
    assert.match(healthProof, /protocolVersion!==1/);
    assert.match(healthProof, /status!=="ready"/);
    const healthInvocation = harness.slice(healthClient, harness.indexOf("<<'NODE'", healthClient));
    assert.match(healthInvocation, /docker run --rm -i --name "\$SUPERVISOR_HEALTH_NAME"[\s\S]*--entrypoint node "\$SUPERVISOR_IMAGE" -/);
    assert.doesNotMatch(healthInvocation, /(?:^|\s)(?:-t|--tty)(?=\s|$)/m);

    const executeClient = harness.indexOf('docker run --rm -i --name cl-piece-step5b1-broker-client', canaryGeneration);
    const executeHeredoc = harness.indexOf("<<'NODE'", executeClient);
    const executeInvocation = harness.slice(executeClient, executeHeredoc);
    assert.ok(executeClient > canaryGeneration && executeHeredoc > executeClient);
    assert.match(executeInvocation, /docker run --rm -i --name cl-piece-step5b1-broker-client[\s\S]*--entrypoint node "\$SUPERVISOR_IMAGE" -/);
    assert.doesNotMatch(executeInvocation, /(?:^|\s)(?:-t|--tty)(?=\s|$)/m);

    const cleanup = harness.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const restore = harness.match(/restore_supervisor_control_ownership\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(restore, /"\$HOST_UID:\$HOST_GID" \/control/);
    assert.match(restore, /stat -c '%u:%g'.*HOST_UID:\$HOST_GID/);
    assert.ok(cleanup.indexOf('docker rm -f "$SUPERVISOR_NAME"') < cleanup.indexOf("restore_supervisor_control_ownership"));
    assert.ok(cleanup.indexOf("restore_supervisor_control_ownership") < cleanup.indexOf('rm -rf -- "$SUPERVISOR_CONTROL"'));
    assert.ok(cleanup.indexOf('rm -rf -- "$SUPERVISOR_CONTROL"') < cleanup.indexOf('docker image rm "$SUPERVISOR_IMAGE"'));
    assert.doesNotMatch(harness, /chmod 0777|\bsudo\b/);

    const sandboxPause = harness.indexOf('docker pause "$SANDBOX_NAME"');
    const registrationLog = harness.indexOf("broker-before-sandbox-unpause.log", sandboxPause);
    const exactRegistration = harness.indexOf("event.event === 'piece_egress_broker_policy_registered'", registrationLog);
    const registrationMarker = harness.indexOf("REGISTER_BEFORE_SANDBOX=PASS", exactRegistration);
    const sandboxUnpause = harness.indexOf('docker unpause "$SANDBOX_NAME"', registrationMarker);
    assert.ok(sandboxPause < registrationLog && registrationLog < exactRegistration && exactRegistration < registrationMarker && registrationMarker < sandboxUnpause);
    const registrationProof = harness.slice(registrationLog, sandboxUnpause);
    assert.match(registrationProof, /invocationId === invocationId/);
    assert.match(registrationProof, /requestId === requestId/);
    assert.match(registrationProof, /capabilityId === 'hubspot\.get_contact'/);
    assert.match(registrationProof, /hostname !== 'api\.hubapi\.com'/);
    assert.match(registrationProof, /destination\?\.port !== 443/);
    assert.match(registrationProof, /classification === 'SAFE'/);

    const connectionProof = harness.slice(harness.indexOf('node - "$ARTIFACT_DIR/broker.log"'));
    assert.match(connectionProof, /event === 'piece_egress_broker_connection'/);
    assert.match(connectionProof, /invocationId === invocationId/);
    assert.match(connectionProof, /requestId === requestId/);
    assert.match(connectionProof, /capabilityId === 'hubspot\.get_contact'/);
    assert.match(connectionProof, /hostname === 'api\.hubapi\.com'/);
    assert.match(connectionProof, /port === 443/);
    assert.match(connectionProof, /upstreamConnections === 1/);
    assert.match(connectionProof, /outcome === 'PIECE_BROKER_SUCCEEDED'/);
    assert.match(connectionProof, /connections\.length !== 1/);
  });

  test("host harness preserves only sanitized bounded failure evidence", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-egress-broker-host-acceptance.sh"), "utf8");
    const cleanup = harness.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const sanitizer = harness.match(/sanitize_failure_evidence\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const diagnostics = harness.match(/capture_failure_diagnostics\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(cleanup, /status != 0.*capture_failure_diagnostics/);
    assert.match(cleanup, /sanitize_failure_evidence/);
    assert.match(cleanup, /status == 0[\s\S]*rm -rf -- "\$ARTIFACT_DIR"/);
    assert.match(cleanup, /EVIDENCE_DIR=%s/);
    assert.match(sanitizer, /shred -u -z -- "\$ARTIFACT_DIR\/request\.json"/);
    assert.match(sanitizer, /rm -f -- "\$ARTIFACT_DIR\/request\.json"/);
    assert.match(sanitizer, /grep -Fq -- "\$CANARY"/);
    assert.match(sanitizer, /grep -Fq -- "\$CANARY_B64"/);
    assert.match(sanitizer, /CANARY=''[\s\S]*CANARY_B64=''/);
    for (const field of [
      "BROKER_RUNNING_RESTART", "BROKER_NETWORKS", "SANDBOX_PRESENT", "INTERNAL_NETWORK_PRESENT",
      "REGISTRATION_EVENT_COUNT", "SAFE_REGISTRATION_COUNT", "CONNECTION_EVENT_COUNT", "PROVIDER_RESPONSE_ERROR_CODE",
    ]) assert.match(diagnostics, new RegExp(field));
    assert.doesNotMatch(diagnostics, /Authorization|credentialBase64|pinnedAddress|raw request|raw provider response/i);
  });
});
