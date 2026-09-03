import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { EgressBrokerPolicyStore, validateBrokerControlMessage, validateEgressBrokerSocketPath } from "../services/piece-runtime/src/egress-broker-control.mjs";
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
    const brokerStart = harness.indexOf('docker run -d --name "$BROKER_NAME"');
    const supervisorStart = harness.indexOf('docker run -d --name "$SUPERVISOR_NAME"');
    assert.ok(brokerStart >= 0 && brokerStart < supervisorStart);
    assert.match(harness, /network none/); assert.match(harness, /crazyloops-piece-egress-control/);
    assert.match(harness, /docker pause "\$SANDBOX_NAME"/); assert.doesNotMatch(harness, /docker pause "\$BROKER_NAME"/);
    assert.match(harness, /cl-piece-gateway-/); assert.match(harness, /cl-piece-egress-/);
    assert.match(harness, /PIECE_AUTH_FAILED/); assert.match(harness, /upstreamConnections\":1/);
    assert.match(harness, /PROTECTED_SERVICES_UNCHANGED=PASS/);
    assert.doesNotMatch(harness, /docker compose|systemctl restart|vercel|supabase/);
  });
});
