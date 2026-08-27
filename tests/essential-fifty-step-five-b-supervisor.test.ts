/* eslint-disable @typescript-eslint/no-explicit-any -- Fake Docker API fixtures intentionally model untyped daemon JSON. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { describe } from "node:test";

import { buildInvocationPlan, PieceContainerEngine } from "../services/piece-runtime/src/container-engine.mjs";
import { DockerClientError } from "../services/piece-runtime/src/docker-client.mjs";
import {
  DockerPieceContainerEngine,
  supervisorContainerConfigurations,
} from "../services/piece-runtime/src/docker-piece-container-engine.mjs";
import { PieceRuntimeError } from "../services/piece-runtime/src/errors.mjs";
import {
  SUPERVISOR_DEFAULT_CONCURRENCY,
  SUPERVISOR_INVOCATION_RESOURCE_LABEL,
  SUPERVISOR_OWNER_LABEL,
  SUPERVISOR_RUNTIME_SPEC,
  SUPERVISOR_SOCKET_PATH,
} from "../services/piece-runtime/src/supervisor-constants.mjs";
import { SupervisorError } from "../services/piece-runtime/src/supervisor-errors.mjs";
import { validateSupervisorEnvelope } from "../services/piece-runtime/src/supervisor-protocol.mjs";
import { validateSupervisorSocketPath } from "../services/piece-runtime/src/supervisor-server.mjs";
import { PieceSupervisorService } from "../services/piece-runtime/src/supervisor-service.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function invocation(requestId = "request-supervisor-1", overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId,
    executionId: `execution-${requestId}`,
    capabilityId: "hubspot.get_contact",
    capabilityVersion: 1,
    mode: "TEST",
    idempotencyKey: `idempotency-${requestId}`,
    input: { contactId: "synthetic-contact", properties: ["firstname"] },
    ...overrides,
  };
}

function envelope(requestId = "request-supervisor-1", overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    request: invocation(requestId, overrides),
    credentialBase64: Buffer.from("synthetic-token", "utf8").toString("base64"),
  };
}

function multiplex(stream: number, value: string) {
  const payload = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

class FakeDocker {
  calls: Array<{ method: string; args: unknown[] }> = [];
  containers = new Map<string, Record<string, any>>();
  networks = new Map<string, Record<string, any>>();
  failAt: string | null = null;
  gatewayAddress = "10.90.0.7";
  workerOutput: Buffer;

  constructor() {
    this.workerOutput = Buffer.from(JSON.stringify({
      protocolVersion: 1,
      requestId: "request-supervisor-1",
      ok: false,
      errorCode: "PIECE_AUTH_FAILED",
      retryable: false,
    }) + "\n");
  }

  record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    if (this.failAt === method) throw new DockerClientError("daemon_failure");
  }

  async createNetwork(configuration: Record<string, any>) {
    this.record("createNetwork", configuration);
    this.networks.set(configuration.Name, { Name: configuration.Name, Labels: configuration.Labels });
    return { Id: configuration.Name };
  }

  async inspectNetwork(name: string) {
    this.record("inspectNetwork", name);
    const value = this.networks.get(name);
    if (!value) throw new DockerClientError("not_found", 404);
    return value;
  }

  async connectNetwork(name: string, configuration: Record<string, any>) {
    this.record("connectNetwork", name, configuration);
    const container = this.containers.get(configuration.Container);
    if (!container) throw new DockerClientError("not_found", 404);
    container.NetworkSettings.Networks[name] = { IPAddress: this.gatewayAddress };
  }

  async removeNetwork(name: string) {
    this.record("removeNetwork", name);
    if (!this.networks.delete(name)) throw new DockerClientError("not_found", 404);
  }

  async createContainer(name: string, configuration: Record<string, any>) {
    this.record("createContainer", name, configuration);
    const network = configuration.HostConfig.NetworkMode;
    this.containers.set(name, {
      Id: name,
      Config: { Labels: configuration.Labels },
      State: { Running: false },
      NetworkSettings: { Networks: { [network]: { IPAddress: this.gatewayAddress } } },
      configuration,
    });
    return { Id: name };
  }

  async startContainer(name: string) {
    this.record("startContainer", name);
    const container = this.containers.get(name);
    if (!container) throw new DockerClientError("not_found", 404);
    container.State.Running = true;
  }

  async inspectContainer(name: string) {
    this.record("inspectContainer", name);
    const value = this.containers.get(name);
    if (!value) throw new DockerClientError("not_found", 404);
    return value;
  }

  async removeContainer(name: string) {
    this.record("removeContainer", name);
    if (!this.containers.delete(name)) throw new DockerClientError("not_found", 404);
  }

  async killContainer(name: string) {
    this.record("killContainer", name);
    const value = this.containers.get(name);
    if (value) value.State.Running = false;
  }

  async containerLogs(name: string) {
    this.record("containerLogs", name);
    return multiplex(1, '{"event":"piece_gateway_ready"}\n');
  }

  async attachAndRun(input: Record<string, any>) {
    this.record("attachAndRun", input);
    await this.startContainer(input.name);
    return Buffer.from(this.workerOutput);
  }

  async listContainers(label: string) {
    this.record("listContainers", label);
    return [...this.containers.values()].map((value) => ({ Id: value.Id, Labels: value.Config.Labels }));
  }

  async listNetworks(label: string) {
    this.record("listNetworks", label);
    return [...this.networks.values()];
  }
}

class HoldingEngine extends PieceContainerEngine {
  calls: any[] = [];
  cleanups: string[] = [];
  releases: Array<() => void> = [];
  credential: Buffer | null = null;

  async runInvocation(value: any) {
    this.calls.push(value);
    this.credential = value.credential;
    await new Promise<void>((resolve) => this.releases.push(resolve));
    return { protocolVersion: 1, requestId: value.request.requestId, ok: false, errorCode: "PIECE_AUTH_FAILED", retryable: false };
  }

  async cleanupInvocation(plan: any) {
    this.cleanups.push(plan.invocationId);
  }
}

describe("Essential 50 Step 5B.1 private piece supervisor", () => {
  test("concrete engine implements the accepted abstraction and creates isolated dynamic topology", async () => {
    const docker = new FakeDocker();
    const engine = new DockerPieceContainerEngine({ docker });
    assert.ok(engine instanceof PieceContainerEngine);
    const request = invocation();
    const plan = buildInvocationPlan(request);
    const credential = Buffer.from("synthetic-token");
    const result = await engine.runInvocation({ plan, request, credential });
    assert.equal(result.errorCode, "PIECE_AUTH_FAILED");
    const networkCreates = docker.calls.filter(({ method }) => method === "createNetwork").map(({ args }) => args[0] as any);
    assert.equal(networkCreates.length, 2);
    assert.equal(networkCreates.find(({ Name }) => Name === plan.names.internalNetwork).Internal, true);
    assert.equal(networkCreates.find(({ Name }) => Name === plan.names.egressNetwork).Internal, false);
    const containerCreates = docker.calls.filter(({ method }) => method === "createContainer");
    const gateway = containerCreates.find(({ args }) => args[0] === plan.names.gateway)?.args[1] as any;
    const sandbox = containerCreates.find(({ args }) => args[0] === plan.names.sandbox)?.args[1] as any;
    assert.deepEqual(Object.keys(gateway.NetworkingConfig.EndpointsConfig), [plan.names.egressNetwork]);
    assert.deepEqual(gateway.HostConfig.Mounts, []);
    assert.deepEqual(Object.keys(sandbox.NetworkingConfig.EndpointsConfig), [plan.names.internalNetwork]);
    assert.deepEqual(sandbox.HostConfig.ExtraHosts, [`api.hubapi.com:${docker.gatewayAddress}`]);
    assert.deepEqual(sandbox.HostConfig.Mounts, []);
    assert.equal(JSON.stringify({ gateway, sandbox }).includes("/var/run/docker.sock"), false);
    await engine.cleanupInvocation(plan);
    assert.equal(docker.containers.size, 0);
    assert.equal(docker.networks.size, 0);
  });

  test("trusted plans produce unique per-invocation resource identities", () => {
    const first = buildInvocationPlan(invocation("request-supervisor-a"));
    const second = buildInvocationPlan(invocation("request-supervisor-b"));
    assert.equal(new Set([...Object.values(first.names), ...Object.values(second.names)]).size, 8);
    assert.notEqual(first.invocationId, second.invocationId);
  });

  test("control input cannot override reviewed Docker or piece metadata", () => {
    for (const key of ["buildId", "piecePackage", "pieceVersion", "actionId", "sandboxImage", "command", "entrypoint", "mounts", "dockerSocket", "network", "hostname", "destinationIp", "port", "resourceLimits"]) {
      const value = envelope();
      (value.request as Record<string, unknown>)[key] = "attacker-controlled";
      assert.throws(() => validateSupervisorEnvelope(value), PieceRuntimeError, key);
    }
  });

  test("credentials decode to mutable buffers and are absent from plans and Docker metadata", () => {
    const parsed = validateSupervisorEnvelope(envelope());
    assert.ok(Buffer.isBuffer(parsed.credential));
    const plan = buildInvocationPlan(parsed.request);
    assert.equal(JSON.stringify(plan).includes("synthetic-token"), false);
    const labels = { [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value, [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value, "crazyloops.invocation": plan.invocationId };
    const gateway = supervisorContainerConfigurations.gateway(plan, labels);
    const sandbox = supervisorContainerConfigurations.sandbox(plan, labels, "10.90.0.7");
    assert.equal(JSON.stringify({ gateway, sandbox }).includes("synthetic-token"), false);
    assert.deepEqual(gateway.HostConfig.Mounts, []);
    assert.deepEqual(sandbox.HostConfig.Mounts, []);
    parsed.credential.fill(0);
  });

  test("duplicate and busy requests create zero extra engine work", async () => {
    const engine = new HoldingEngine();
    const service = new PieceSupervisorService({ engine, concurrencyLimit: 2 });
    service.setReady();
    const first = service.execute(envelope("request-supervisor-a"));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.execute(envelope("request-supervisor-a")), (error: any) => error.code === "SUPERVISOR_DUPLICATE");
    const second = service.execute(envelope("request-supervisor-b"));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.execute(envelope("request-supervisor-c")), (error: any) => error.code === "SUPERVISOR_BUSY");
    assert.equal(engine.calls.length, 2);
    engine.releases.splice(0).forEach((release) => release());
    await Promise.all([first, second]);
    assert.equal(service.health().activeInvocations, 0);
  });

  test("service clears credential buffers and invokes cleanup", async () => {
    const engine = new HoldingEngine();
    const service = new PieceSupervisorService({ engine });
    service.setReady();
    const execution = service.execute(envelope());
    await new Promise((resolve) => setImmediate(resolve));
    const captured = engine.credential!;
    assert.ok(captured.some((byte) => byte !== 0));
    engine.releases[0]();
    await execution;
    assert.ok(captured.every((byte) => byte === 0));
    assert.equal(engine.cleanups.length, 1);
  });

  test("HubSpot remains READ-only, TEST-only, and one-attempt", async () => {
    const service = new PieceSupervisorService({ engine: new HoldingEngine() });
    service.setReady();
    await assert.rejects(service.execute(envelope("request-live", { mode: "LIVE" })), (error: any) => error.code === "PIECE_ACTION_NOT_ALLOWED");
    const manifestSource = readFileSync(resolve(ROOT, "services/piece-runtime/src/manifest-registry.mjs"), "utf8");
    assert.match(manifestSource, /operationClassification: "READ"/);
    assert.match(manifestSource, /modes: \["TEST"\]/);
    assert.match(manifestSource, /runtimeAttempts: 1/);
    assert.match(manifestSource, /safeAutomaticRetry: false/);
  });

  test("every Docker lifecycle failure remains bounded and cleanup is idempotent", async () => {
    for (const failure of ["createNetwork", "createContainer", "connectNetwork", "startContainer", "attachAndRun"]) {
      const docker = new FakeDocker();
      docker.failAt = failure;
      const engine = new DockerPieceContainerEngine({ docker });
      const request = invocation();
      const plan = buildInvocationPlan(request);
      await assert.rejects(engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") }), PieceRuntimeError);
      docker.failAt = null;
      await engine.cleanupInvocation(plan);
      await engine.cleanupInvocation(plan);
      assert.equal(docker.containers.size, 0, failure);
      assert.equal(docker.networks.size, 0, failure);
    }
  });

  test("cleanup attempts every owned resource even when one Docker removal fails", async () => {
    const docker = new FakeDocker();
    const engine = new DockerPieceContainerEngine({ docker });
    const request = invocation();
    const plan = buildInvocationPlan(request);
    await engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") });
    docker.failAt = "removeContainer";
    await assert.rejects(engine.cleanupInvocation(plan), (error: any) => error.code === "PIECE_RUNTIME_FAILED");
    assert.equal(docker.calls.filter(({ method }) => method === "removeContainer").length, 2);
    assert.equal(docker.calls.filter(({ method }) => method === "removeNetwork").length, 2);
  });

  test("malformed and oversized worker output fail with bounded vocabulary and no stderr", async () => {
    for (const output of [Buffer.from("not-json\n"), Buffer.alloc(150 * 1024, 1)]) {
      const docker = new FakeDocker();
      docker.workerOutput = output;
      const engine = new DockerPieceContainerEngine({ docker });
      const request = invocation();
      const plan = buildInvocationPlan(request);
      await assert.rejects(engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") }), (error: any) => error.code === "PIECE_RESPONSE_INVALID" || error.code === "PIECE_RUNTIME_FAILED");
      await engine.cleanupInvocation(plan);
    }
  });

  test("orphan cleanup uses only the exact Step 5B owner label", async () => {
    const docker = new FakeDocker();
    const engine = new DockerPieceContainerEngine({ docker });
    const plan = buildInvocationPlan(invocation());
    const owned = { [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value, [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value, "crazyloops.invocation": plan.invocationId };
    const unrelated = { "crazyloops.runtime": "piece-runtime-step5a", "crazyloops.invocation": "unrelated" };
    docker.containers.set("owned", { Id: "owned", Config: { Labels: owned }, State: {}, NetworkSettings: { Networks: {} } });
    docker.containers.set("unrelated", { Id: "unrelated", Config: { Labels: unrelated }, State: {}, NetworkSettings: { Networks: {} } });
    docker.networks.set("owned-network", { Id: "owned-network", Labels: owned });
    docker.networks.set("unrelated-network", { Id: "unrelated-network", Labels: unrelated });
    await engine.cleanupOrphans();
    assert.equal(docker.containers.has("owned"), false);
    assert.equal(docker.networks.has("owned-network"), false);
    assert.equal(docker.containers.has("unrelated"), true);
    assert.equal(docker.networks.has("unrelated-network"), true);
    assert.ok(docker.calls.some(({ method, args }) => method === "listContainers" && args[0] === "crazyloops.runtime=piece-runtime-supervisor-v1"));
  });

  test("socket validation permits only the reviewed UDS path", () => {
    assert.equal(validateSupervisorSocketPath(SUPERVISOR_SOCKET_PATH), SUPERVISOR_SOCKET_PATH);
    for (const path of ["piece-supervisor.sock", "/tmp/piece-supervisor.sock", "/run/crazyloops-piece/../piece-supervisor.sock", "/run/crazyloops-piece/other.sock"]) {
      assert.throws(() => validateSupervisorSocketPath(path), SupervisorError);
    }
  });

  test("supervisor runtime is UDS-only and Docker socket authority is isolated", () => {
    assert.equal(SUPERVISOR_RUNTIME_SPEC.networkMode, "none");
    assert.deepEqual(SUPERVISOR_RUNTIME_SPEC.publishedPorts, []);
    assert.equal(SUPERVISOR_RUNTIME_SPEC.privileged, false);
    assert.equal(SUPERVISOR_RUNTIME_SPEC.readOnlyRoot, true);
    assert.deepEqual(SUPERVISOR_RUNTIME_SPEC.capDrop, ["ALL"]);
    assert.equal(SUPERVISOR_RUNTIME_SPEC.noNewPrivileges, true);
    assert.equal(SUPERVISOR_DEFAULT_CONCURRENCY, 2);
    assert.deepEqual(SUPERVISOR_RUNTIME_SPEC.mounts.map(({ target }: any) => target), ["/var/run/docker.sock", "/run/crazyloops-piece"]);
    const server = readFileSync(resolve(ROOT, "services/piece-runtime/src/supervisor-server.mjs"), "utf8");
    assert.match(server, /server\.listen\(socketPath/);
    assert.doesNotMatch(server, /listen\([^\n]*(?:127\.0\.0\.1|0\.0\.0\.0|localhost|[0-9]{4})/);
    assert.match(server, /SUPERVISOR_MAX_REQUEST_BYTES/);
    assert.match(server, /SUPERVISOR_MAX_RESPONSE_BYTES/);
    assert.match(server, /request\.url === "\/v1\/health"/);
    assert.match(server, /request\.url !== "\/v1\/execute"/);
    assert.match(server, /controller\.abort\(\)/);
    assert.match(server, /chmodSync\(socketPath, SUPERVISOR_SOCKET_MODE\)/);
  });

  test("Docker client is direct, dependency-free, and exposes no raw proxy", () => {
    const source = readFileSync(resolve(ROOT, "services/piece-runtime/src/docker-client.mjs"), "utf8");
    assert.match(source, /socketPath: this\.socketPath/);
    assert.doesNotMatch(source, /child_process|exec\(|spawn\(|dockerode/);
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "services/piece-runtime/package.json"), "utf8"));
    assert.deepEqual(Object.keys(packageJson.dependencies), ["@activepieces/piece-hubspot"]);
  });

  test("product and existing Connector Runner remain disconnected from supervisor", () => {
    for (const file of [
      "lib/capability-registry.ts", "lib/connectors/registry.ts", "lib/workflow-planner.ts", "lib/workflow-compiler.ts",
      "services/connector-runner/src/runner.mjs",
    ]) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      assert.doesNotMatch(source, /piece-supervisor|piece-runtime-supervisor|DockerPieceContainerEngine|\/var\/run\/docker\.sock/);
    }
  });

  test("supervisor image is minimal, non-root, and contains only reviewed runtime modules", () => {
    const dockerfile = readFileSync(resolve(ROOT, "services/piece-runtime/Dockerfile.supervisor"), "utf8");
    assert.match(dockerfile, /node:24\.8\.0-bookworm-slim@sha256:/);
    assert.match(dockerfile, /USER 65532:65532/);
    assert.doesNotMatch(dockerfile, /COPY \. |npm install|apt-get|curl|ENTRYPOINT \["sh"/);
  });

  test("owner harness is gated, label-scoped, UDS-only, and never deploys product", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-supervisor-host-acceptance.sh"), "utf8");
    assert.match(harness, /E50_ACCEPT_STEP5B1/);
    assert.match(harness, /E50_EXPECTED_STEP5B1_COMMIT/);
    assert.match(harness, /353b2c4821b1b959aeb7f485beade3a5eaf219fd/);
    assert.match(harness, /20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7/);
    assert.match(harness, /--network none/);
    assert.match(harness, /--read-only/);
    assert.match(harness, /--cap-drop=ALL/);
    assert.match(harness, /--security-opt=no-new-privileges/);
    assert.match(harness, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
    assert.match(harness, /curl[^\n]*--unix-socket/);
    assert.match(harness, /trap cleanup EXIT INT TERM/);
    assert.match(harness, /crazyloops\.runtime=piece-runtime-supervisor-v1/);
    assert.match(harness, /STEP5B1_SUPERVISOR_CONTAINERS/);
    assert.match(harness, /STEP5B1_INVOCATION_CONTAINERS/);
    assert.match(harness, /STEP5B1_INVOCATION_NETWORKS/);
    assert.doesNotMatch(harness, /--privileged|--network host|vercel deploy|git push|docker rm \$\(docker ps -aq\)/);
  });
});
