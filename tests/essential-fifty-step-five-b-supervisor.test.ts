/* eslint-disable @typescript-eslint/no-explicit-any -- Fake Docker API fixtures intentionally model untyped daemon JSON. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { describe } from "node:test";

import { buildInvocationPlan, PieceContainerEngine } from "../services/piece-runtime/src/container-engine.mjs";
import { DockerClientError } from "../services/piece-runtime/src/docker-client.mjs";
import {
  DockerPieceContainerEngine,
  supervisorContainerConfigurations,
} from "../services/piece-runtime/src/docker-piece-container-engine.mjs";
import { PIECE_ERROR_CODES, PieceRuntimeError } from "../services/piece-runtime/src/errors.mjs";
import {
  SUPERVISOR_BODY_TIMEOUT_MS,
  SUPERVISOR_DEFAULT_CONCURRENCY,
  SUPERVISOR_FORCE_CLOSE_MS,
  SUPERVISOR_HEADERS_TIMEOUT_MS,
  SUPERVISOR_INVOCATION_RESOURCE_LABEL,
  SUPERVISOR_KEEP_ALIVE_TIMEOUT_MS,
  SUPERVISOR_MAX_CONTROL_CONNECTIONS,
  SUPERVISOR_OWNER_LABEL,
  SUPERVISOR_RUNTIME_SPEC,
  SUPERVISOR_SERVICE_RESOURCE_LABEL,
  SUPERVISOR_SHUTDOWN_GRACE_MS,
  SUPERVISOR_SOCKET_DIRECTORY_MODE,
  SUPERVISOR_SOCKET_MODE,
  SUPERVISOR_SOCKET_PATH,
} from "../services/piece-runtime/src/supervisor-constants.mjs";
import { SupervisorError } from "../services/piece-runtime/src/supervisor-errors.mjs";
import { validateSupervisorEnvelope } from "../services/piece-runtime/src/supervisor-protocol.mjs";
import { validateSupervisorSocketPath } from "../services/piece-runtime/src/supervisor-server.mjs";
import { PieceSupervisorService } from "../services/piece-runtime/src/supervisor-service.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SELF_CONTAINER_NAME = "cl-piece-step5b1-supervisor";

function supervisorLabels() {
  return {
    [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value,
    [SUPERVISOR_SERVICE_RESOURCE_LABEL.key]: SUPERVISOR_SERVICE_RESOURCE_LABEL.value,
  };
}

function dockerEngine(docker: FakeDocker) {
  return new DockerPieceContainerEngine({ docker, selfContainerName: SELF_CONTAINER_NAME });
}

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

function successfulWorkerResult(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId: "request-supervisor-1",
    ok: true,
    acknowledged: true,
    output: { id: "synthetic-contact" },
    meta: {
      capabilityId: "hubspot.get_contact",
      capabilityVersion: 1,
      providerId: "hubspot",
      pieceVersion: "0.8.10",
      actionId: "get-contact",
      classification: "READ",
      attempts: 1,
    },
    ...overrides,
  };
}

class FakeDocker {
  calls: Array<{ method: string; args: unknown[] }> = [];
  containers = new Map<string, Record<string, any>>();
  networks = new Map<string, Record<string, any>>();
  failAt: string | null = null;
  gatewayAddress = "10.90.0.7";
  gatewayAddressBeforeStart: string | null = null;
  gatewayAddressAssignedOnStart = false;
  workerOutput: Buffer;
  lastReturnedOutput: Buffer | null = null;
  listedContainers: Array<Record<string, any>> | null = null;

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
    container.NetworkSettings.Networks[name] = { IPAddress: "" };
    this.gatewayAddressBeforeStart = container.NetworkSettings.Networks[name].IPAddress;
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
      NetworkSettings: { Networks: { [network]: { IPAddress: "" } } },
      configuration,
    });
    return { Id: name };
  }

  async startContainer(name: string) {
    this.record("startContainer", name);
    const container = this.containers.get(name);
    if (!container) throw new DockerClientError("not_found", 404);
    container.State.Running = true;
    for (const endpoint of Object.values(container.NetworkSettings.Networks) as Array<Record<string, any>>) {
      if (!endpoint.IPAddress && !endpoint.GlobalIPv6Address) endpoint.IPAddress = this.gatewayAddress;
    }
    this.gatewayAddressAssignedOnStart = true;
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
    this.lastReturnedOutput = Buffer.from(this.workerOutput);
    return this.lastReturnedOutput;
  }

  async listContainers(label: string) {
    this.record("listContainers", label);
    if (this.listedContainers) return this.listedContainers;
    return [...this.containers.values()].map((value) => ({
      Id: value.Id,
      Labels: value.Config.Labels,
      State: value.State?.Running === true ? "running" : "exited",
    }));
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

class CleanupFailingEngine extends PieceContainerEngine {
  calls: any[] = [];
  cleanupAttempts = 0;
  failCleanup = true;
  credential: Buffer | null = null;

  async runInvocation(value: any) {
    this.calls.push(value);
    this.credential = value.credential;
    return {
      protocolVersion: 1,
      requestId: value.request.requestId,
      ok: false,
      errorCode: "PIECE_AUTH_FAILED",
      retryable: false,
    };
  }

  async cleanupInvocation() {
    this.cleanupAttempts += 1;
    if (this.failCleanup) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
}

describe("Essential 50 Step 5B.1 private piece supervisor", () => {
  test("concrete engine implements the accepted abstraction and creates isolated dynamic topology", async () => {
    const docker = new FakeDocker();
    const engine = dockerEngine(docker);
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
    assert.equal(docker.gatewayAddressBeforeStart, "");
    assert.equal(docker.gatewayAddressAssignedOnStart, true);

    const internalCreate = docker.calls.findIndex(({ method, args }) => method === "createNetwork" && (args[0] as any).Name === plan.names.internalNetwork);
    const egressCreate = docker.calls.findIndex(({ method, args }) => method === "createNetwork" && (args[0] as any).Name === plan.names.egressNetwork);
    const gatewayCreate = docker.calls.findIndex(({ method, args }) => method === "createContainer" && args[0] === plan.names.gateway);
    const gatewayConnect = docker.calls.findIndex(({ method, args }) => method === "connectNetwork" && args[0] === plan.names.internalNetwork);
    const gatewayStart = docker.calls.findIndex(({ method, args }) => method === "startContainer" && args[0] === plan.names.gateway);
    const readyLog = docker.calls.findIndex(({ method, args }) => method === "containerLogs" && args[0] === plan.names.gateway);
    const startedGatewayInspect = docker.calls.findIndex(({ method, args }, index) => index > readyLog && method === "inspectContainer" && args[0] === plan.names.gateway);
    const sandboxCreate = docker.calls.findIndex(({ method, args }) => method === "createContainer" && args[0] === plan.names.sandbox);
    const sandboxRun = docker.calls.findIndex(({ method, args }) => method === "attachAndRun" && (args[0] as any).name === plan.names.sandbox);
    assert.ok(internalCreate < egressCreate);
    assert.ok(egressCreate < gatewayCreate);
    assert.ok(gatewayCreate < gatewayConnect);
    assert.ok(gatewayConnect < gatewayStart);
    assert.ok(gatewayStart < readyLog);
    assert.ok(readyLog < startedGatewayInspect);
    assert.ok(startedGatewayInspect < sandboxCreate);
    assert.ok(sandboxCreate < sandboxRun);
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
      const engine = dockerEngine(docker);
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
    const engine = dockerEngine(docker);
    const request = invocation();
    const plan = buildInvocationPlan(request);
    await engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") });
    docker.failAt = "removeContainer";
    await assert.rejects(engine.cleanupInvocation(plan), (error: any) => error.code === "PIECE_RUNTIME_FAILED");
    assert.equal(docker.calls.filter(({ method }) => method === "removeContainer").length, 2);
    assert.equal(docker.calls.filter(({ method }) => method === "removeNetwork").length, 2);
    assert.equal(engine.resources.has(plan.invocationId), true);
    docker.failAt = null;
    await engine.cleanupInvocation(plan);
    assert.equal(engine.resources.has(plan.invocationId), false);
    assert.equal(docker.containers.size, 0);
    assert.equal(docker.networks.size, 0);
  });

  test("cleanup failure degrades the supervisor and retains the active slot until verified retry", async () => {
    const engine = new CleanupFailingEngine();
    const logs: any[] = [];
    const service = new PieceSupervisorService({ engine, logger: (event: any) => logs.push(event) });
    service.setReady();
    await assert.rejects(service.execute(envelope()), (error: any) => error.code === "PIECE_RUNTIME_FAILED");
    assert.ok(engine.credential?.every((byte) => byte === 0));
    assert.equal(service.health().ok, false);
    assert.equal(service.health().status, "unavailable");
    assert.equal(service.health().activeInvocations, 1);
    assert.equal(engine.calls.length, 1);
    await assert.rejects(service.execute(envelope("request-after-degrade")), (error: any) => error.code === "SUPERVISOR_UNAVAILABLE");
    assert.equal(engine.calls.length, 1);
    assert.equal(logs.some((event) => event.event === "piece_supervisor_cleanup_failed" && event.errorCode === "PIECE_RUNTIME_FAILED"), true);
    engine.failCleanup = false;
    const shutdown = await service.shutdown(500);
    assert.deepEqual(shutdown, { clean: true, activeInvocations: 0 });
    assert.equal(engine.cleanupAttempts, 2);
    assert.equal(service.health().activeInvocations, 0);
  });

  test("malformed and oversized worker output fail with bounded vocabulary and no stderr", async () => {
    for (const output of [Buffer.from("not-json\n"), Buffer.alloc(150 * 1024, 1)]) {
      const docker = new FakeDocker();
      docker.workerOutput = output;
      const engine = dockerEngine(docker);
      const request = invocation();
      const plan = buildInvocationPlan(request);
      await assert.rejects(engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") }), (error: any) => error.code === "PIECE_RESPONSE_INVALID" || error.code === "PIECE_RUNTIME_FAILED");
      assert.ok(docker.lastReturnedOutput?.every((byte) => byte === 0));
      await engine.cleanupInvocation(plan);
    }
  });

  test("worker failure and success responses are exact reviewed vocabulary", async () => {
    const invalidResults = [
      {
        protocolVersion: 1,
        requestId: "request-supervisor-1",
        ok: false,
        errorCode: "PIECE_SECRET_DUMP",
        retryable: false,
      },
      successfulWorkerResult({ meta: { ...successfulWorkerResult().meta, providerId: "spoofed" } }),
      successfulWorkerResult({ meta: { ...successfulWorkerResult().meta, extra: "unreviewed" } }),
      successfulWorkerResult({ meta: { ...successfulWorkerResult().meta, attempts: 2 } }),
      successfulWorkerResult({ output: [] }),
    ];
    for (const value of invalidResults) {
      const docker = new FakeDocker();
      docker.workerOutput = Buffer.from(`${JSON.stringify(value)}\n`);
      const engine = dockerEngine(docker);
      const request = invocation();
      const plan = buildInvocationPlan(request);
      await assert.rejects(
        engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") }),
        (error: any) => error.code === "PIECE_RESPONSE_INVALID",
      );
      assert.ok(docker.lastReturnedOutput?.every((byte) => byte === 0));
      await engine.cleanupInvocation(plan);
    }

    for (const errorCode of PIECE_ERROR_CODES) {
      const docker = new FakeDocker();
      docker.workerOutput = Buffer.from(`${JSON.stringify({
        protocolVersion: 1,
        requestId: "request-supervisor-1",
        ok: false,
        errorCode,
        retryable: false,
      })}\n`);
      const engine = dockerEngine(docker);
      const request = invocation();
      const plan = buildInvocationPlan(request);
      const result = await engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") });
      assert.equal(result.errorCode, errorCode);
      assert.ok(docker.lastReturnedOutput?.every((byte) => byte === 0));
      await engine.cleanupInvocation(plan);
    }

    const docker = new FakeDocker();
    docker.workerOutput = Buffer.from(`${JSON.stringify(successfulWorkerResult())}\n`);
    const engine = dockerEngine(docker);
    const request = invocation();
    const plan = buildInvocationPlan(request);
    const result = await engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") });
    assert.equal(result.ok, true);
    assert.equal(result.meta.attempts, 1);
    assert.ok(docker.lastReturnedOutput?.every((byte) => byte === 0));
    await engine.cleanupInvocation(plan);
  });

  test("orphan cleanup proceeds only for exactly one running, correctly labelled self", async () => {
    const docker = new FakeDocker();
    const plan = buildInvocationPlan(invocation());
    const invocationLabels = {
      [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value,
      [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value,
      "crazyloops.invocation": plan.invocationId,
    };
    docker.containers.set(SELF_CONTAINER_NAME, {
      Id: "self-docker-id",
      Config: { Labels: supervisorLabels() },
      State: { Running: true },
      NetworkSettings: { Networks: {} },
    });
    docker.containers.set("owned", { Id: "owned", Config: { Labels: invocationLabels }, State: { Running: false }, NetworkSettings: { Networks: {} } });
    docker.networks.set("owned-network", { Id: "owned-network", Labels: invocationLabels });
    const engine = dockerEngine(docker);
    assert.equal(await engine.assertSingleActiveSupervisor(), "self-docker-id");
    await engine.cleanupOrphans();
    assert.equal(docker.containers.has("owned"), false);
    assert.equal(docker.networks.has("owned-network"), false);
    assert.equal(docker.containers.has(SELF_CONTAINER_NAME), true);
    const firstRemove = docker.calls.findIndex(({ method }) => method === "removeContainer" || method === "removeNetwork");
    const singletonList = docker.calls.findIndex(({ method }) => method === "listContainers");
    assert.ok(singletonList >= 0 && firstRemove > singletonList);
  });

  test("gateway start, readiness, and valid started address gate sandbox creation", async () => {
    const scenarios = [
      { name: "gateway start", failAt: "startContainer", gatewayAddress: "10.90.0.7" },
      { name: "gateway readiness", failAt: "containerLogs", gatewayAddress: "10.90.0.7" },
      { name: "started gateway address", failAt: null, gatewayAddress: "" },
    ];

    for (const scenario of scenarios) {
      const docker = new FakeDocker();
      docker.failAt = scenario.failAt;
      docker.gatewayAddress = scenario.gatewayAddress;
      const engine = dockerEngine(docker);
      const request = invocation(`request-${scenario.name.replaceAll(" ", "-")}`);
      const plan = buildInvocationPlan(request);

      await assert.rejects(
        engine.runInvocation({ plan, request, credential: Buffer.from("synthetic-token") }),
        PieceRuntimeError,
      );
      assert.equal(
        docker.calls.some(({ method, args }) => method === "createContainer" && args[0] === plan.names.sandbox),
        false,
        scenario.name,
      );
      assert.equal(
        docker.calls.some(({ method }) => method === "attachAndRun"),
        false,
        scenario.name,
      );

      docker.failAt = null;
      await engine.cleanupInvocation(plan);
      assert.equal(docker.containers.size, 0, scenario.name);
      assert.equal(docker.networks.size, 0, scenario.name);
      assert.equal(docker.calls.filter(({ method }) => method === "removeContainer").length, 1, scenario.name);
      assert.equal(docker.calls.filter(({ method }) => method === "removeNetwork").length, 2, scenario.name);
    }
  });

  test("zero active supervisors fails closed before orphan deletion", async () => {
    const docker = new FakeDocker();
    const labels = { ...supervisorLabels(), [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value };
    docker.containers.set("owned", { Id: "owned", Config: { Labels: labels }, State: { Running: false }, NetworkSettings: { Networks: {} } });
    await assert.rejects(dockerEngine(docker).cleanupOrphans(), (error: any) => error.code === "SUPERVISOR_UNAVAILABLE");
    assert.equal(docker.containers.has("owned"), true);
    assert.equal(docker.calls.some(({ method }) => method === "removeContainer" || method === "removeNetwork"), false);
  });

  test("two running supervisors fail closed before orphan deletion", async () => {
    const docker = new FakeDocker();
    for (const [name, id] of [[SELF_CONTAINER_NAME, "self-docker-id"], ["second-supervisor", "second-docker-id"]]) {
      docker.containers.set(name, { Id: id, Config: { Labels: supervisorLabels() }, State: { Running: true }, NetworkSettings: { Networks: {} } });
    }
    const orphanLabels = { [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value, [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value };
    docker.containers.set("owned", { Id: "owned", Config: { Labels: orphanLabels }, State: { Running: false }, NetworkSettings: { Networks: {} } });
    await assert.rejects(dockerEngine(docker).cleanupOrphans(), (error: any) => error.code === "SUPERVISOR_UNAVAILABLE");
    assert.equal(docker.containers.has("owned"), true);
    assert.equal(docker.calls.some(({ method }) => method === "removeContainer" || method === "removeNetwork"), false);
  });

  test("mislabelled self fails closed before orphan deletion", async () => {
    const docker = new FakeDocker();
    docker.containers.set(SELF_CONTAINER_NAME, {
      Id: "self-docker-id",
      Config: { Labels: { [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value } },
      State: { Running: true },
      NetworkSettings: { Networks: {} },
    });
    docker.networks.set("owned-network", {
      Id: "owned-network",
      Labels: { [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value, [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value },
    });
    await assert.rejects(dockerEngine(docker).cleanupOrphans(), (error: any) => error.code === "SUPERVISOR_UNAVAILABLE");
    assert.equal(docker.networks.has("owned-network"), true);
    assert.equal(docker.calls.some(({ method }) => method === "removeNetwork"), false);
  });

  test("a listed singleton that is not inspected self fails closed", async () => {
    const docker = new FakeDocker();
    docker.containers.set(SELF_CONTAINER_NAME, {
      Id: "self-docker-id",
      Config: { Labels: supervisorLabels() },
      State: { Running: true },
      NetworkSettings: { Networks: {} },
    });
    docker.listedContainers = [{ Id: "different-docker-id", Labels: supervisorLabels(), State: "running" }];
    await assert.rejects(dockerEngine(docker).cleanupOrphans(), (error: any) => error.code === "SUPERVISOR_UNAVAILABLE");
    assert.equal(docker.calls.some(({ method }) => method === "removeContainer" || method === "removeNetwork"), false);
  });

  test("stopped stale supervisors do not count against one running self", async () => {
    const docker = new FakeDocker();
    docker.containers.set(SELF_CONTAINER_NAME, { Id: "self-docker-id", Config: { Labels: supervisorLabels() }, State: { Running: true }, NetworkSettings: { Networks: {} } });
    docker.containers.set("stopped-supervisor", { Id: "stopped-id", Config: { Labels: supervisorLabels() }, State: { Running: false }, NetworkSettings: { Networks: {} } });
    assert.equal(await dockerEngine(docker).assertSingleActiveSupervisor(), "self-docker-id");
  });

  test("unrelated labels do not count and unrelated resources remain untouched", async () => {
    const docker = new FakeDocker();
    docker.containers.set(SELF_CONTAINER_NAME, { Id: "self-docker-id", Config: { Labels: supervisorLabels() }, State: { Running: true }, NetworkSettings: { Networks: {} } });
    const owned = { [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value, [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value };
    const unrelated = { "crazyloops.runtime": "piece-runtime-step5a", "crazyloops.resource": "supervisor" };
    docker.containers.set("owned", { Id: "owned", Config: { Labels: owned }, State: { Running: false }, NetworkSettings: { Networks: {} } });
    docker.containers.set("unrelated", { Id: "unrelated", Config: { Labels: unrelated }, State: { Running: true }, NetworkSettings: { Networks: {} } });
    docker.networks.set("owned-network", { Id: "owned-network", Labels: owned });
    docker.networks.set("unrelated-network", { Id: "unrelated-network", Labels: unrelated });
    await dockerEngine(docker).cleanupOrphans();
    assert.equal(docker.containers.has("owned"), false);
    assert.equal(docker.networks.has("owned-network"), false);
    assert.equal(docker.containers.has("unrelated"), true);
    assert.equal(docker.networks.has("unrelated-network"), true);
  });

  test("supervisor self container names are strictly bounded", () => {
    const docker = new FakeDocker();
    for (const value of [undefined, "", "/host/name", "bad name", `.bad`, "a".repeat(129)]) {
      assert.throws(() => new DockerPieceContainerEngine({ docker, selfContainerName: value }), (error: any) => error.code === "SUPERVISOR_UNAVAILABLE");
    }
  });

  test("socket validation permits only the reviewed UDS path", () => {
    assert.equal(validateSupervisorSocketPath(SUPERVISOR_SOCKET_PATH), SUPERVISOR_SOCKET_PATH);
    assert.equal(SUPERVISOR_SOCKET_MODE, 0o660);
    assert.equal(SUPERVISOR_SOCKET_DIRECTORY_MODE, 0o750);
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
    assert.equal(SUPERVISOR_MAX_CONTROL_CONNECTIONS, 8);
    assert.equal(SUPERVISOR_HEADERS_TIMEOUT_MS, 5_000);
    assert.equal(SUPERVISOR_BODY_TIMEOUT_MS, 10_000);
    assert.equal(SUPERVISOR_KEEP_ALIVE_TIMEOUT_MS, 1);
    assert.equal(SUPERVISOR_SHUTDOWN_GRACE_MS, 8_000);
    assert.equal(SUPERVISOR_FORCE_CLOSE_MS, 2_000);
    assert.deepEqual(SUPERVISOR_SERVICE_RESOURCE_LABEL, { key: "crazyloops.resource", value: "supervisor" });
    assert.deepEqual(SUPERVISOR_RUNTIME_SPEC.mounts.map(({ target }: any) => target), ["/var/run/docker.sock", "/run/crazyloops-piece"]);
    const server = readFileSync(resolve(ROOT, "services/piece-runtime/src/supervisor-server.mjs"), "utf8");
    assert.match(server, /server\.listen\(socketPath/);
    assert.doesNotMatch(server, /listen\([^\n]*(?:127\.0\.0\.1|0\.0\.0\.0|localhost|[0-9]{4})/);
    assert.match(server, /SUPERVISOR_MAX_REQUEST_BYTES/);
    assert.match(server, /SUPERVISOR_MAX_RESPONSE_BYTES/);
    assert.match(server, /server\.headersTimeout = SUPERVISOR_HEADERS_TIMEOUT_MS/);
    assert.match(server, /server\.requestTimeout = SUPERVISOR_BODY_TIMEOUT_MS/);
    assert.match(server, /server\.keepAliveTimeout = SUPERVISOR_KEEP_ALIVE_TIMEOUT_MS/);
    assert.match(server, /server\.maxRequestsPerSocket = 1/);
    assert.match(server, /server\.maxConnections = SUPERVISOR_MAX_CONTROL_CONNECTIONS/);
    assert.match(server, /const zeroChunks = \(\) =>/);
    assert.match(server, /request\.once\("error", onError\)/);
    assert.match(server, /request\.once\("aborted", onAborted\)/);
    assert.match(server, /request\.pause\(\)/);
    assert.doesNotMatch(server, /request\.destroy\(\)/);
    assert.match(server, /server\.closeAllConnections\?\.\(\)/);
    assert.match(server, /settlesWithin\(closed, SUPERVISOR_FORCE_CLOSE_MS\)/);
    assert.match(server, /request\.url === "\/v1\/health"/);
    assert.match(server, /request\.url !== "\/v1\/execute"/);
    assert.match(server, /controller\.abort\(\)/);
    assert.match(server, /chmodSync\(socketPath, SUPERVISOR_SOCKET_MODE\)/);
    const supervisor = readFileSync(resolve(ROOT, "services/piece-runtime/src/supervisor.mjs"), "utf8");
    assert.match(supervisor, /selfContainerName: process\.env\.PIECE_SUPERVISOR_CONTAINER_NAME/);
    assert.match(supervisor, /piece_supervisor_shutdown_failed/);
    assert.match(supervisor, /errorCode: "SUPERVISOR_UNAVAILABLE"/);
    assert.match(supervisor, /process\.exitCode = 1/);
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
    assert.doesNotMatch(harness, /git fetch origin main/);
    assert.match(harness, /git rev-parse origin\/main/);
    assert.match(harness, /origin\/main changed from the reviewed production baseline/);
    assert.match(harness, /git branch --show-current/);
    assert.match(harness, /git rev-parse HEAD/);
    assert.match(harness, /git status --porcelain/);
    assert.match(harness, /git merge-base --is-ancestor "\$ACCEPTED_STEP5A" HEAD/);
    assert.match(harness, /--network none/);
    assert.match(harness, /--read-only/);
    assert.match(harness, /--cap-drop=ALL/);
    assert.match(harness, /--security-opt=no-new-privileges/);
    assert.match(harness, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
    assert.match(harness, /SOCKET_AND_DIR_MODES=.*docker exec "\$SUPERVISOR_NAME"/);
    assert.match(harness, /SOCKET_AND_DIR_MODES.*== '660:750'/);
    assert.match(harness, /Config\.User !== '65532:65532'/);
    assert.match(harness, /CapEff !== '0000000000000000'/);
    assert.match(harness, /NoNewPrivs !== '1'/);
    assert.match(harness, /Seccomp !== '2'/);
    assert.match(harness, /\/sys\/fs\/cgroup\/pids\.max/);
    assert.match(harness, /\/sys\/fs\/cgroup\/memory\.max/);
    assert.match(harness, /\/sys\/fs\/cgroup\/cpu\.max/);
    assert.doesNotMatch(harness, /curl[^\n]*--unix-socket/);
    assert.match(harness, /trap cleanup EXIT INT TERM/);
    assert.match(harness, /crazyloops\.runtime=piece-runtime-supervisor-v1/);
    assert.match(harness, /SUPERVISOR_RESOURCE_LABEL='crazyloops\.resource=supervisor'/);
    assert.match(harness, /PIECE_SUPERVISOR_CONTAINER_NAME="\$SUPERVISOR_NAME"/);
    assert.match(harness, /No already-running Step 5B\.1 supervisor/);
    assert.match(harness, /count_active_supervisors/);
    assert.match(harness, /active_supervisor_ids/);
    assert.match(harness, /self Docker identity/);
    assert.match(harness, /STEP5B1_SUPERVISOR_CONTAINERS/);
    assert.match(harness, /STEP5B1_INVOCATION_CONTAINERS/);
    assert.match(harness, /STEP5B1_INVOCATION_NETWORKS/);
    assert.match(harness, /docker network inspect "\$INTERNAL_NAME" "\$EGRESS_NAME"/);
    assert.match(harness, /internal\.Internal !== true/);
    assert.match(harness, /egress\.Internal !== false/);
    assert.match(harness, /piece_gateway_dns/);
    assert.match(harness, /piece_gateway_connection/);
    assert.match(harness, /PIECE_GATEWAY_SUCCEEDED/);
    assert.match(harness, /expect_error "\$ARTIFACT_DIR\/response\.json" 'PIECE_AUTH_FAILED'/);
    assert.match(harness, /expect_error "\$ARTIFACT_DIR\/unsupported-response\.json" 'PIECE_UNSUPPORTED_CAPABILITY'/);
    assert.match(harness, /expect_error "\$ARTIFACT_DIR\/malformed-credential-response\.json" 'PIECE_INVALID_CREDENTIAL'/);
    assert.match(harness, /expect_error "\$ARTIFACT_DIR\/worker-failure-response\.json" 'PIECE_INVALID_INPUT'/);
    assert.match(harness, /CANARY_B64/);
    assert.match(harness, /grep -Fq "\$CANARY_B64"/);
    assert.match(harness, /docker top "\$SUPERVISOR_NAME"/);
    assert.match(harness, /docker top "\$SANDBOX_NAME"/);
    assert.match(harness, /docker top "\$GATEWAY_NAME"/);
    assert.match(harness, /assert_no_docker_socket_mount/);
    assert.match(harness, /docker stop --time 20/);
    assert.doesNotMatch(harness, /DUPLICATE_PROTECTION=PASS|CONCURRENCY_LIMIT=PASS/);
    assert.doesNotMatch(harness, /--privileged|--network host|vercel deploy|git push|docker rm \$\(docker ps -aq\)/);
  });

  test("owner harness cleanup is exact-resource scoped and safe on preflight failure", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-supervisor-host-acceptance.sh"), "utf8");
    const cleanup = harness.match(/\ncleanup\(\) \{\n([\s\S]*?)\n\}/)?.[1];
    assert.ok(cleanup);
    assert.doesNotMatch(cleanup, /docker ps -aq|docker network ls -q/);
    assert.doesNotMatch(cleanup, /docker rm -f "?\$\{?owned_|docker network rm "?\$\{?owned_/);
    assert.doesNotMatch(cleanup, /docker image rm -f "\$SUPERVISOR_IMAGE" "\$GATEWAY_IMAGE" "\$SANDBOX_IMAGE"/);
    assert.match(cleanup, /SUPERVISOR_CREATED.*remove_acceptance_supervisor_exact "\$SUPERVISOR_NAME"/);
    assert.match(cleanup, /HOST_INVOCATION_STARTED.*remove_invocation_topology_exact "\$HOST_INVOCATION_ID"/);
    assert.match(cleanup, /WORKER_FAILURE_INVOCATION_STARTED.*remove_invocation_topology_exact "\$WORKER_FAILURE_INVOCATION_ID"/);
    assert.match(cleanup, /STALE_CONTAINER_CREATED.*remove_acceptance_container_exact "\$STALE_CONTAINER_NAME" 'stale-proof'/);
    assert.match(cleanup, /STALE_NETWORK_CREATED.*remove_acceptance_network_exact "\$STALE_NETWORK_NAME" 'stale-proof'/);
    assert.match(harness, /remove_acceptance_container_exact\(\)[\s\S]*OWNER_LABEL_VALUE\|invocation\|\$expected_invocation/);
    assert.match(harness, /remove_acceptance_network_exact\(\)[\s\S]*OWNER_LABEL_VALUE\|invocation\|\$expected_invocation/);
    assert.match(harness, /remove_acceptance_supervisor_exact\(\)[\s\S]*OWNER_LABEL_VALUE\|supervisor/);
    assert.match(harness, /SUPERVISOR_CREATED=0[\s\S]*SUPERVISOR_IMAGE_BUILT_BY_HARNESS=0[\s\S]*trap cleanup EXIT INT TERM/);
    assert.match(harness, /Pre-existing acceptance image tag is outside harness cleanup authority/);
    assert.match(harness, /SANDBOX_IMAGE_BUILT_BY_HARNESS=1/);
    assert.match(harness, /GATEWAY_IMAGE_BUILT_BY_HARNESS=1/);
    assert.match(harness, /SUPERVISOR_IMAGE_BUILT_BY_HARNESS=1/);
    assert.match(harness, /HOST_REQUEST_ID='step5b1-host-invocation'/);
    assert.match(harness, /WORKER_FAILURE_REQUEST_ID='step5b1-negative-worker'/);
    assert.match(harness, /HOST_INVOCATION_ID=.*sha256sum/);
    assert.match(harness, /WORKER_FAILURE_INVOCATION_ID=.*sha256sum/);
    assert.match(harness, /No already-running Step 5B\.1 supervisor/);
    assert.match(harness, /active_supervisors\[0\].*SUPERVISOR_DOCKER_ID/);
  });

  test("owner harness transfers directory ownership and reaches UDS through isolated helpers", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-supervisor-host-acceptance.sh"), "utf8");
    assert.doesNotMatch(harness, /^\s*chown 65532:65532 "\$CONTROL_DIR"/m);
    assert.doesNotMatch(harness, /\bsudo\b/);
    assert.match(harness, /HOST_UID="\$\(id -u\)"/);
    assert.match(harness, /HOST_GID="\$\(id -g\)"/);

    const ownership = harness.match(/run_control_ownership_helper\(\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(ownership);
    assert.match(ownership, /--network none/);
    assert.match(ownership, /--read-only/);
    assert.match(ownership, /--cap-drop=ALL --cap-add=CHOWN/);
    assert.equal((ownership.match(/--cap-add=/g) ?? []).length, 1);
    assert.match(ownership, /--security-opt=no-new-privileges/);
    assert.match(ownership, /--user=0:0/);
    assert.match(ownership, /--mount type=bind,src="\$CONTROL_DIR",dst=\/control/);
    assert.equal((ownership.match(/--mount/g) ?? []).length, 1);
    assert.doesNotMatch(ownership, /docker\.sock|--privileged|CAP_DAC_OVERRIDE|CAP_SYS_ADMIN|--network host/);
    assert.match(ownership, /--entrypoint \/usr\/bin\/chown/);
    assert.match(harness, /run_control_ownership_helper "\$CONTROL_INIT_HELPER_NAME" '65532:65532'/);
    assert.match(harness, /stat -c '%u:%g:%a'.*== '65532:65532:750'/);
    assert.match(harness, /restore_control_dir_ownership\(\)/);
    assert.match(harness, /run_control_ownership_helper "\$CONTROL_RESTORE_HELPER_NAME" "\$HOST_UID:\$HOST_GID"/);

    const cleanup = harness.match(/\ncleanup\(\) \{\n([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.ok(cleanup.indexOf("restore_control_dir_ownership") < cleanup.indexOf('remove_acceptance_image_exact "$SUPERVISOR_IMAGE"'));
    assert.match(harness, /CONTROL_INIT_HELPER_NAME='cl-piece-step5b1-control-init'/);
    assert.match(harness, /CONTROL_RESTORE_HELPER_NAME='cl-piece-step5b1-control-restore'/);
    assert.match(harness, /ACCEPTANCE_HELPER_LABEL='crazyloops\.acceptance=step5b1-control-helper'/);

    assert.doesNotMatch(harness, /curl[^\n]*--unix-socket/);
    assert.match(harness, /UDS_HEALTH_CLIENT_NAME='cl-piece-step5b1-uds-health'/);
    assert.match(harness, /UDS_EXECUTE_CLIENT_NAME='cl-piece-step5b1-uds-execute'/);
    assert.match(harness, /socketPath: '\/control\/piece-supervisor\.sock'/);
    assert.match(harness, /request\.setTimeout\(timeoutMs/);
    assert.match(harness, /body\.fill\(0\)/);
    assert.match(harness, /MAX_INPUT_BYTES = 96 \* 1024/);
    assert.match(harness, /Content-Length[\s\S]*String\(body\.length\)/);
    assert.match(harness, /--user=65532:65532/);
    assert.match(harness, /--network none --read-only --cap-drop=ALL --security-opt=no-new-privileges/);
    assert.match(harness, /--mount type=bind,src="\$CONTROL_DIR",dst=\/control,readonly/);
    assert.match(harness, /docker create --rm --interactive[\s\S]*--entrypoint node "\$SUPERVISOR_IMAGE"/);
    assert.match(harness, /docker start --attach --interactive "\$UDS_EXECUTE_CLIENT_NAME" <"\$input" >"\$output"/);
    assert.doesNotMatch(harness, /--env[^\n]*(?:credential|CANARY)|--label[^\n]*(?:credential|CANARY)/i);
    assert.match(harness, /uds-client-inspect\.json/);
    assert.match(harness, /uds-execute-client-inspect\.json/);
    assert.match(harness, /uds-client-processes\.txt/);
    assert.match(harness, /docker exec "\$SUPERVISOR_NAME" node -e[\s\S]*SOCKET_AND_DIR_MODES/);
    assert.match(harness, /SOCKET_AND_DIR_MODES.*== '660:750'/);
    assert.match(harness, /CONTROL_DIR_UID=65532/);
    assert.match(harness, /CONTROL_DIR_GID=65532/);
    assert.match(harness, /CONTROL_DIR_MODE=750/);
    assert.match(harness, /SOCKET_MODE=660/);
  });

  test("owner harness uses immutable exact identities and fail-safe observation cleanup", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-supervisor-host-acceptance.sh"), "utf8");
    assert.match(harness, /OBSERVATION_GATEWAY_ID=''/);
    assert.match(harness, /OBSERVATION_GATEWAY_PAUSED=0/);
    assert.match(harness, /OBSERVATION_SUPERVISOR_ID=''/);
    assert.match(harness, /OBSERVATION_SUPERVISOR_PAUSED=0/);
    assert.match(harness, /OBSERVATION_WATCHER_PID=''/);
    assert.match(harness, /OBSERVATION_HELD=0/);
    assert.match(harness, /OBSERVATION_RELEASED=0/);

    const gatewayIdentity = harness.match(/acceptance_invocation_container_id_is_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(gatewayIdentity, /\.Name/);
    assert.match(gatewayIdentity, /crazyloops\.runtime/);
    assert.match(gatewayIdentity, /crazyloops\.resource/);
    assert.match(gatewayIdentity, /crazyloops\.invocation/);
    assert.match(gatewayIdentity, /\/\$name\|\$OWNER_LABEL_VALUE\|invocation\|\$invocation/);
    const gatewayId = harness.match(/acceptance_invocation_container_id_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(gatewayId, /docker inspect --format '\{\{\.Id\}\}' "\$name"/);
    assert.match(gatewayId, /acceptance_invocation_container_id_is_exact "\$id" "\$name" "\$invocation"/);

    const supervisorIdentity = harness.match(/acceptance_supervisor_id_is_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(supervisorIdentity, /\.Name/);
    assert.match(supervisorIdentity, /crazyloops\.runtime/);
    assert.match(supervisorIdentity, /crazyloops\.resource/);
    assert.match(supervisorIdentity, /\/\$name\|\$OWNER_LABEL_VALUE\|supervisor/);

    const pause = harness.match(/pause_acceptance_gateway_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const unpause = harness.match(/unpause_acceptance_gateway_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const pauseSupervisor = harness.match(/pause_acceptance_supervisor_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const unpauseSupervisor = harness.match(/unpause_acceptance_supervisor_exact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(pause, /acceptance_invocation_container_id_is_exact/);
    assert.match(pause, /'true\|false'/);
    assert.match(pause, /docker pause "\$id"/);
    assert.match(pause, /'true\|true'/);
    assert.match(unpause, /acceptance_invocation_container_id_is_exact/);
    assert.match(unpause, /docker unpause "\$id"/);
    assert.match(unpause, /'true\|false'/);
    assert.match(pauseSupervisor, /acceptance_supervisor_id_is_exact/);
    assert.match(pauseSupervisor, /docker pause "\$id"/);
    assert.match(pauseSupervisor, /'true\|true'/);
    assert.match(unpauseSupervisor, /acceptance_supervisor_id_is_exact/);
    assert.match(unpauseSupervisor, /docker unpause "\$id"/);
    assert.match(unpauseSupervisor, /'true\|false'/);
    for (const protectedName of ["crazyloops-connector-runner", "activepieces-app", "activepieces-worker-1", "redis"]) {
      assert.doesNotMatch(`${pause}\n${unpause}\n${pauseSupervisor}\n${unpauseSupervisor}`, new RegExp(protectedName));
    }

    const startBarrier = harness.match(/wait_for_gateway_start_event_and_hold\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.doesNotMatch(harness, /wait_for_gateway_start_and_pause/);
    assert.match(startBarrier, /timeout --signal=TERM --kill-after=2s 8s docker events/);
    assert.match(startBarrier, /--since "\$since"/);
    assert.match(startBarrier, /--filter type=container/);
    assert.match(startBarrier, /--filter event=start/);
    assert.match(startBarrier, /--filter "container=\$name"/);
    assert.match(startBarrier, /mkfifo "\$event_pipe"/);
    assert.match(startBarrier, /IFS= read -r -t 8 event <"\$event_pipe"/);
    assert.match(startBarrier, /kill "\$event_pid"/);
    assert.match(startBarrier, /wait "\$event_pid"/);
    assert.match(startBarrier, /crazyloops\.runtime/);
    assert.match(startBarrier, /crazyloops\.resource/);
    assert.match(startBarrier, /crazyloops\.invocation/);
    assert.match(startBarrier, /acceptance_invocation_container_id_exact/);
    assert.match(startBarrier, /\[\[ "\$id" == "\$event_id" \]\]/);
    const supervisorFreeze = startBarrier.indexOf("pause_acceptance_supervisor_exact");
    const gatewayPause = startBarrier.indexOf("pause_acceptance_gateway_exact");
    const sandboxAbsent = startBarrier.indexOf("acceptance_container_is_absent");
    assert.ok(supervisorFreeze >= 0 && supervisorFreeze < gatewayPause && gatewayPause < sandboxAbsent);
    assert.match(startBarrier, /printf '%s\\n' "\$id" >"\$id_output"/);
    assert.match(startBarrier, /START_EVENT_OBSERVED=PASS/);
    assert.match(startBarrier, /SUPERVISOR_STARTUP_FREEZE=PASS/);
    assert.match(startBarrier, /GATEWAY_STARTUP_HOLD=PASS/);
    assert.doesNotMatch(startBarrier, /while \(\( SECONDS|sleep 0\.01/);

    const watcher = harness.match(/start_gateway_log_watcher\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(watcher, /timeout --signal=TERM --kill-after=2s 25s docker logs --follow "\$id"/);
    assert.match(watcher, /OBSERVATION_WATCHER_PID=\$!/);
    assert.match(watcher, /observation-watcher-process\.txt/);
    assert.doesNotMatch(watcher, /CANARY|CANARY_B64|credentialBase64|--env|--label/);

    const cleanup = harness.match(/\ncleanup\(\) \{\n([\s\S]*?)\n\}/)?.[1] ?? "";
    const watcherCleanup = cleanup.indexOf("stop_observation_watcher");
    const gatewayCleanup = cleanup.indexOf("release_observation_gateway_for_cleanup");
    const supervisorRelease = cleanup.indexOf("release_observation_supervisor_for_cleanup");
    const executeCleanup = cleanup.indexOf("stop_execute_process");
    const invocationCleanup = cleanup.indexOf('remove_invocation_topology_exact "$HOST_INVOCATION_ID"');
    const supervisorCleanup = cleanup.indexOf('remove_acceptance_supervisor_exact "$SUPERVISOR_NAME"');
    assert.ok(watcherCleanup >= 0 && watcherCleanup < gatewayCleanup);
    assert.ok(gatewayCleanup < supervisorRelease && supervisorRelease < executeCleanup);
    assert.ok(executeCleanup < invocationCleanup && invocationCleanup < supervisorCleanup);
    assert.match(harness, /stop_observation_watcher\(\)[\s\S]*kill "\$OBSERVATION_WATCHER_PID"[\s\S]*wait "\$OBSERVATION_WATCHER_PID"/);
    assert.match(harness, /release_observation_gateway_for_cleanup\(\)[\s\S]*acceptance_invocation_container_id_is_exact[\s\S]*unpause_acceptance_gateway_exact/);
    assert.match(harness, /release_observation_supervisor_for_cleanup\(\)[\s\S]*acceptance_supervisor_id_is_exact[\s\S]*unpause_acceptance_supervisor_exact/);
    assert.match(harness, /remove_acceptance_invocation_container_id_exact\(\)[\s\S]*acceptance_invocation_container_id_is_exact[\s\S]*docker rm -f "\$id"/);
    assert.match(cleanup, /remove_invocation_topology_exact "\$HOST_INVOCATION_ID" "\$OBSERVATION_GATEWAY_ID"/);
    assert.match(harness, /remove_acceptance_supervisor_exact "\$SUPERVISOR_NAME" "\$OBSERVATION_SUPERVISOR_ID"/);
  });

  test("owner harness freezes the supervisor across the strict real-ready transition", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-supervisor-host-acceptance.sh"), "utf8");
    const docs = readFileSync(resolve(ROOT, "docs/piece-runtime/SUPERVISOR_V1.md"), "utf8");
    assert.match(harness, /READY_TRANSITION_TIMEOUT_MS=750/);

    const hold = harness.match(/hold_gateway_after_ready\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const supervisorProof = hold.indexOf("acceptance_supervisor_id_is_exact");
    const alreadyReady = hold.indexOf("READY_PATH=ALREADY_READY");
    const gatewayUnpause = hold.indexOf("unpause_acceptance_gateway_exact");
    const readyProof = hold.indexOf("gateway_ready_event_is_exact");
    const gatewayRepause = hold.indexOf('\n    pause_acceptance_gateway_exact');
    const transitionReady = hold.indexOf("READY_PATH=TRANSITION_READY");
    const heldMarker = hold.indexOf("OBSERVATION_HELD");
    assert.ok(supervisorProof >= 0 && supervisorProof < alreadyReady);
    assert.ok(alreadyReady < gatewayUnpause);
    assert.ok(gatewayUnpause < gatewayRepause && gatewayRepause < transitionReady && transitionReady < heldMarker);
    assert.ok(readyProof >= 0);
    assert.match(hold, /if grep -Fq '"event":"piece_gateway_ready"' "\$initial_log_file"/);
    assert.match(hold, /gateway_ready_event_is_exact "\$initial_log_file" "\$request_id"/);
    assert.match(hold, /gateway_ready_event_is_exact "\$log_file" "\$request_id"/);
    assert.match(hold, /acceptance_container_is_absent "\$sandbox_name"/);
    assert.match(hold, /started_ms="\$\(date \+%s%3N\)"/);
    assert.match(hold, /deadline_ms=\$\(\(started_ms \+ READY_TRANSITION_TIMEOUT_MS\)\)/);
    assert.match(hold, /acceptance_invocation_container_id_is_exact/);
    assert.match(hold, /'true\|true'/);
    assert.doesNotMatch(hold, /SECONDS \+ 3|sleep [1-9]/);

    const main = harness.slice(harness.indexOf("HOST_INVOCATION_STARTED=1"), harness.indexOf("assert_zero_invocation_resources 'Invocation resources survived request completion.'"));
    const eventCursor = main.indexOf("START_EVENT_SINCE=");
    const startupPause = main.indexOf("wait_for_gateway_start_event_and_hold");
    const executeStart = main.indexOf("start_execute_client");
    const startupWait = main.indexOf('wait "$OBSERVATION_WATCHER_PID"');
    const watcher = main.indexOf("start_gateway_log_watcher");
    const preReady = main.indexOf("pre-transition-gateway-logs.txt");
    const held = main.indexOf("hold_gateway_after_ready");
    const heldState = main.indexOf("Observation held state is invalid");
    const supervisorResume = main.indexOf("unpause_acceptance_supervisor_exact");
    const sandboxWait = main.indexOf("wait_for_sandbox_running_exact");
    const capture = main.indexOf('docker inspect "$SANDBOX_NAME" "$GATEWAY_NAME"');
    const release = main.indexOf('unpause_acceptance_gateway_exact "$OBSERVATION_GATEWAY_ID"');
    const completion = main.indexOf('wait "$EXECUTE_PID"');
    const providerResult = main.indexOf("expect_error \"$ARTIFACT_DIR/response.json\" 'PIECE_AUTH_FAILED'");
    assert.ok(eventCursor >= 0 && eventCursor < startupPause && startupPause < executeStart && executeStart < startupWait);
    assert.ok(startupWait < watcher && watcher < preReady && preReady < held);
    assert.ok(held < heldState && heldState < supervisorResume);
    assert.ok(supervisorResume < sandboxWait && sandboxWait < capture);
    assert.ok(capture < release && release < completion && completion < providerResult);
    assert.doesNotMatch(main, /for _ in \$\(seq 1 500\)[\s\S]*TOPOLOGY_CAPTURED/);
    assert.match(main, /OBSERVATION_HELD.*OBSERVATION_GATEWAY_PAUSED.*OBSERVATION_SUPERVISOR_PAUSED.*OBSERVATION_RELEASED/);
    assert.doesNotMatch(main, /Gateway became ready before the supervisor freeze was established/);
    assert.match(main, /Sandbox was created before the event-driven startup barrier/);
    assert.match(main, /OBSERVATION_SUPERVISOR_PAUSED=1/);
    assert.match(main, /OBSERVATION_SUPERVISOR_PAUSED=0/);
    assert.match(main, /wait_for_execute_client_running/);
    assert.match(main, /docker cp "\$OBSERVATION_GATEWAY_ID:\/etc\/hosts" "\$ARTIFACT_DIR\/gateway-etc-hosts"/);
    assert.doesNotMatch(main, /docker exec "\$GATEWAY_NAME"[^\n]*\/etc\/hosts/);
    assert.match(main, /'true\|false'.*Exact acceptance gateway release was not proven/);
    assert.match(main, /OBSERVATION_RELEASED=1/);
    assert.ok(main.indexOf("wait_for_gateway_start_event_and_hold") < main.indexOf("start_execute_client"));
    assert.match(main, /observation-start-since\.txt/);
    assert.match(main, /kill -0 "\$OBSERVATION_WATCHER_PID"[\s\S]*START_EVENT_WATCHER_ARMED=PASS[\s\S]*start_execute_client/);
    assert.match(main, /STARTUP_OBSERVATION_BARRIER=PASS/);
    assert.match(main, /observation-start-watcher-process\.txt/);
    assert.match(main, /STARTUP_GATEWAY_HELD/);

    const createClient = harness.match(/create_execute_client\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const startClient = harness.match(/start_execute_client\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(createClient, /docker create --rm --interactive/);
    assert.match(createClient, /--name "\$UDS_EXECUTE_CLIENT_NAME"/);
    assert.match(createClient, /docker inspect "\$UDS_EXECUTE_CLIENT_NAME"/);
    assert.match(createClient, /validate_uds_client_inspect/);
    assert.doesNotMatch(createClient, /request\.json|credentialBase64|CANARY|CANARY_B64|docker\.sock/);
    assert.match(startClient, /docker start --attach --interactive/);
    assert.match(startClient, /<"\$input" >"\$output"/);
    assert.ok(main.indexOf("create_execute_client") < main.indexOf("start_execute_client"));
    assert.match(harness, /observation-watcher-process\.txt/);
    assert.match(harness, /observation-start-watcher-process\.txt/);
    assert.match(harness, /observation-start-held\.txt/);
    assert.match(harness, /observation-supervisor-paused\.txt/);
    assert.match(harness, /observation-supervisor-resumed\.txt/);
    assert.match(harness, /observation-held\.txt/);
    assert.match(harness, /observation-released\.txt/);
    assert.match(docs, /Step 5B\.1 owner-host attempt 2/);
    assert.match(docs, /be6414cb34570082a8f06200ce6e70b9d88bb678/);
    assert.match(docs, /harness observation race/);
    assert.match(docs, /provider result from this attempt was not accepted/i);
    assert.match(docs, /readiness-to-repause scheduler\s+race/);
    assert.match(docs, /SUPERVISOR FROZEN -> GATEWAY UNPAUSED -> REAL READY/);
    assert.match(docs, /GATEWAY\s+PAUSED -> EXACT READY PROVEN -> SANDBOX ABSENT -> SUPERVISOR RESUMED/);
    assert.match(docs, /fresh remote fetch and verify/);
    assert.match(docs, /does not perform a second GitHub fetch/);
    assert.match(docs, /missing or mismatched `origin\/main`\s+tracking ref fails closed/);
    assert.match(docs, /START GATEWAY -> REAL GATEWAY READY -> INSPECT VALID INTERNAL ADDRESS/);
    assert.match(docs, /bounded, replay-safe Docker start-event/);
    assert.match(docs, /gateway identity, invocation labels, and immutable container ID/);
    assert.match(docs, /sandbox must be absent before readiness/);
    assert.match(docs, /If the exact ready event was already emitted/);
  });

  test("post-release acceptance checks fail with bounded stage diagnostics", () => {
    const harness = readFileSync(resolve(ROOT, "scripts/e50-step5b1-supervisor-host-acceptance.sh"), "utf8");
    const releaseStart = harness.indexOf("printf 'OBSERVATION_RELEASED\\n'");
    const providerResult = harness.indexOf("expect_error \"$ARTIFACT_DIR/response.json\" 'PIECE_AUTH_FAILED'", releaseStart);
    assert.ok(releaseStart >= 0 && providerResult > releaseStart);
    const postRelease = harness.slice(releaseStart, providerResult);

    assert.doesNotMatch(postRelease, /^\s*wait "\$EXECUTE_PID"\s*$/m);
    assert.match(postRelease, /if ! wait "\$EXECUTE_PID"; then[\s\S]*EXECUTE_PID=''[\s\S]*fail 'UDS execute client exited nonzero after gateway release\.'/);
    assert.match(postRelease, /if ! node - "\$ARTIFACT_DIR\/invocation-inspect\.json"[\s\S]*fail 'Captured invocation topology validation failed\.'/);
    assert.match(postRelease, /if ! node - "\$ARTIFACT_DIR\/live-gateway-logs\.txt"[\s\S]*fail 'Gateway DNS\/connection evidence validation failed\.'/);
    assert.match(postRelease, /invocation-networks\.json".*>\/dev\/null 2>&1 <<'NODE'/);
    assert.match(postRelease, /live-gateway-logs\.txt" >\/dev\/null 2>&1 <<'NODE'/);
    assert.match(harness, /start_execute_client.*2>\/dev\/null &/);
    assert.match(postRelease, /POST_RELEASE_EXECUTE_CLIENT=PASS/);
    assert.match(postRelease, /POST_RELEASE_TOPOLOGY=PASS/);
    assert.match(postRelease, /POST_RELEASE_GATEWAY_EVIDENCE=PASS/);
    assert.match(harness, /READY_TRANSITION_TIMEOUT_MS=750/);
    assert.match(harness, /Gateway readiness observation barrier was not established/);
    assert.match(harness, /OBSERVATION_HELD.*OBSERVATION_GATEWAY_PAUSED.*OBSERVATION_SUPERVISOR_PAUSED.*OBSERVATION_RELEASED/);

    const diagnostics = [
      "UDS execute client exited nonzero after gateway release.",
      "Captured invocation topology validation failed.",
      "Gateway DNS/connection evidence validation failed.",
    ].join(" ");
    assert.doesNotMatch(diagnostics, /credential|request body|provider response|environment|Docker inspect|gateway logs/i);

    const changedRuntimeFiles = execFileSync(
      "git",
      ["diff", "--name-only", "6b6153d478f0c205574ca79e13dcaa312f20952b", "--", "services/piece-runtime/src"],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    assert.equal(changedRuntimeFiles, "");
  });
});
