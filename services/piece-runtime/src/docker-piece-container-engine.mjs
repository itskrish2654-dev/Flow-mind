import { isIP } from "node:net";

import { PieceContainerEngine } from "./container-engine.mjs";
import { DockerClientError, decodeDockerMultiplexed } from "./docker-client.mjs";
import { PIECE_ERROR_CODES, PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import {
  SUPERVISOR_INVOCATION_RESOURCE_LABEL,
  SUPERVISOR_OWNER_LABEL,
  SUPERVISOR_SERVICE_RESOURCE_LABEL,
} from "./supervisor-constants.mjs";
import { SupervisorError } from "./supervisor-errors.mjs";

const INVOCATION_LABEL_KEY = "crazyloops.invocation";
const DOCKER_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function validatedSelfContainerName(value) {
  if (typeof value !== "string" || !DOCKER_CONTAINER_NAME.test(value)) {
    throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
  }
  return value;
}

function unavailable() {
  return new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
}

function nanoCpus(cpus) {
  return Math.round(cpus * 1_000_000_000);
}

function ulimit(value) {
  const [soft, hard] = value.split(":").map(Number);
  return [{ Name: "nofile", Soft: soft, Hard: hard }];
}

function labelsFor(plan) {
  return {
    [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value,
    [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value,
    [INVOCATION_LABEL_KEY]: plan.invocationId,
  };
}

function securityOptions(value) {
  return value ? ["no-new-privileges"] : [];
}

function validGatewayAddress(value) {
  return typeof value === "string" && isIP(value) !== 0 && value !== "0.0.0.0" && value !== "::" && value !== "127.0.0.1" && value !== "::1";
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  return actual.length === reviewed.length && actual.every((key, index) => key === reviewed[index]);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safeWorkerResult(buffer, requestId, maximumBytes, manifest) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > maximumBytes) {
      throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
    }
    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw new Error("invalid line count");
    const value = JSON.parse(lines[0]);
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      value.protocolVersion !== 1 || value.requestId !== requestId || typeof value.ok !== "boolean"
    ) throw new Error("invalid worker result");
    if (value.ok === true) {
      if (!exactKeys(value, ["acknowledged", "meta", "ok", "output", "protocolVersion", "requestId"])) {
        throw new Error("invalid success result");
      }
      const output = record(value.output);
      const meta = record(value.meta);
      if (
        value.acknowledged !== true || !output || !meta ||
        !exactKeys(meta, [
          "capabilityId", "capabilityVersion", "providerId", "pieceVersion",
          "actionId", "classification", "attempts",
        ]) ||
        meta.capabilityId !== manifest.capabilityId ||
        meta.capabilityVersion !== manifest.capabilityVersion ||
        meta.providerId !== manifest.providerId ||
        meta.pieceVersion !== manifest.pieceVersion ||
        meta.actionId !== manifest.actionId ||
        meta.classification !== manifest.operationClassification ||
        meta.attempts !== 1
      ) {
        throw new Error("invalid success result");
      }
    } else {
      if (!exactKeys(value, ["errorCode", "ok", "protocolVersion", "requestId", "retryable"])) {
        throw new Error("invalid failure result");
      }
      if (!PIECE_ERROR_CODES.includes(value.errorCode) || typeof value.retryable !== "boolean") {
        throw new Error("invalid failure result");
      }
    }
    return value;
  } catch (error) {
    if (error instanceof PieceRuntimeError) throw error;
    throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
  } finally {
    if (Buffer.isBuffer(buffer)) buffer.fill(0);
  }
}

function gatewayContainerConfiguration(plan, labels) {
  return {
    Image: plan.images.gateway,
    User: plan.gateway.user,
    Env: Object.entries(plan.gateway.environment).map(([key, value]) => `${key}=${value}`),
    Labels: labels,
    HostConfig: {
      NetworkMode: plan.names.egressNetwork,
      ReadonlyRootfs: plan.gateway.readOnlyRoot,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m" },
      CapDrop: plan.gateway.capDrop,
      SecurityOpt: securityOptions(plan.gateway.noNewPrivileges),
      PidsLimit: plan.gateway.pidsLimit,
      Memory: plan.gateway.memoryBytes,
      MemorySwap: plan.gateway.memorySwapBytes,
      NanoCpus: nanoCpus(plan.gateway.cpus),
      Ulimits: ulimit(plan.gateway.nofile),
      Mounts: [],
      PortBindings: {},
      PublishAllPorts: false,
      Privileged: false,
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
    NetworkingConfig: { EndpointsConfig: { [plan.names.egressNetwork]: {} } },
  };
}

function sandboxContainerConfiguration(plan, labels, gatewayAddress) {
  const tmpfs = plan.sandbox.tmpfs.split(":");
  return {
    Image: plan.images.sandbox,
    User: plan.sandbox.user,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Env: [],
    Labels: labels,
    HostConfig: {
      NetworkMode: plan.names.internalNetwork,
      ReadonlyRootfs: plan.sandbox.readOnlyRoot,
      Tmpfs: { [tmpfs[0]]: tmpfs.slice(1).join(":") },
      CapDrop: plan.sandbox.capDrop,
      SecurityOpt: securityOptions(plan.sandbox.noNewPrivileges),
      PidsLimit: plan.sandbox.pidsLimit,
      Memory: plan.sandbox.memoryBytes,
      MemorySwap: plan.sandbox.memorySwapBytes,
      NanoCpus: nanoCpus(plan.sandbox.cpus),
      Ulimits: ulimit(plan.sandbox.nofile),
      Mounts: [],
      PortBindings: {},
      PublishAllPorts: false,
      Privileged: false,
      LogConfig: { Type: "none", Config: {} },
      ExtraHosts: plan.sandbox.canonicalHostMappings.map(({ hostname }) => `${hostname}:${gatewayAddress}`),
    },
    NetworkingConfig: { EndpointsConfig: { [plan.names.internalNetwork]: {} } },
  };
}

function networkConfiguration(name, internal, labels) {
  return {
    Name: name,
    CheckDuplicate: true,
    Driver: "bridge",
    Internal: internal,
    Attachable: false,
    Ingress: false,
    Labels: labels,
    Options: {},
  };
}

function mapDockerFailure(error) {
  if (error instanceof PieceRuntimeError) return error;
  if (error instanceof DockerClientError && error.kind === "timeout") return new PieceRuntimeError("PIECE_TIMEOUT", true);
  if (error instanceof DockerClientError && error.kind === "stdout_limit") return new PieceRuntimeError("PIECE_RESPONSE_INVALID");
  return new PieceRuntimeError("PIECE_RUNTIME_FAILED");
}

export class DockerPieceContainerEngine extends PieceContainerEngine {
  /** @param {{docker?: *, logger?: Function, selfContainerName?: string}} options */
  constructor({ docker, logger = () => undefined, selfContainerName } = {}) {
    super();
    if (!docker) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    this.docker = docker;
    this.logger = logger;
    this.selfContainerName = validatedSelfContainerName(selfContainerName);
    this.resources = new Map();
  }

  async runInvocation({ plan, request, credential, signal = undefined }) {
    const labels = labelsFor(plan);
    const state = { plan, labels, internalCreated: false, egressCreated: false, gatewayCreated: false, sandboxCreated: false };
    this.resources.set(plan.invocationId, state);
    let envelope = null;
    try {
      const manifest = REVIEWED_MANIFESTS.get(request.capabilityId, request.capabilityVersion);
      if (manifest.operationClassification !== "READ" || request.mode !== "TEST" || !manifest.modes.includes(request.mode)) {
        throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
      }
      await this.docker.createNetwork(networkConfiguration(plan.names.internalNetwork, true, labels));
      state.internalCreated = true;
      await this.docker.createNetwork(networkConfiguration(plan.names.egressNetwork, false, labels));
      state.egressCreated = true;
      await this.docker.createContainer(plan.names.gateway, gatewayContainerConfiguration(plan, labels));
      state.gatewayCreated = true;
      await this.docker.connectNetwork(plan.names.internalNetwork, {
        Container: plan.names.gateway,
        EndpointConfig: { Aliases: plan.gateway.internalAliases },
      });
      const gateway = await this.docker.inspectContainer(plan.names.gateway);
      const gatewayAddress = gateway?.NetworkSettings?.Networks?.[plan.names.internalNetwork]?.IPAddress ||
        gateway?.NetworkSettings?.Networks?.[plan.names.internalNetwork]?.GlobalIPv6Address;
      if (!validGatewayAddress(gatewayAddress)) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
      await this.docker.createContainer(
        plan.names.sandbox,
        sandboxContainerConfiguration(plan, labels, gatewayAddress),
      );
      state.sandboxCreated = true;
      await this.docker.startContainer(plan.names.gateway);
      await this.waitForGateway(plan, signal);
      envelope = Buffer.from(JSON.stringify({ request, credentialBase64: credential.toString("base64") }), "utf8");
      const output = await this.docker.attachAndRun({
        name: plan.names.sandbox,
        input: envelope,
        maximumStdoutBytes: manifest.maximumResponseBytes + 8 * 1024,
        timeoutMs: manifest.resourceLimits.executionTimeoutMs + 1_000,
        signal,
      });
      const gatewayAfter = await this.docker.inspectContainer(plan.names.gateway);
      if (gatewayAfter?.State?.Running !== true) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
      return safeWorkerResult(output, request.requestId, manifest.maximumResponseBytes + 8 * 1024, manifest);
    } catch (error) {
      throw mapDockerFailure(error);
    } finally {
      envelope?.fill(0);
    }
  }

  async waitForGateway(plan, signal) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DockerClientError("aborted");
      const inspect = await this.docker.inspectContainer(plan.names.gateway);
      if (inspect?.State?.Running !== true) throw new DockerClientError("gateway_failure");
      const raw = await this.docker.containerLogs(plan.names.gateway);
      try {
        const logs = decodeDockerMultiplexed(raw, 32 * 1024).toString("utf8");
        if (logs.includes('"event":"piece_gateway_ready"')) return;
      } catch {
        if (raw.toString("utf8").includes('"event":"piece_gateway_ready"')) return;
      } finally {
        raw.fill(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new DockerClientError("timeout");
  }

  async cleanupInvocation(plan) {
    const tracked = this.resources.get(plan.invocationId);
    const labels = tracked?.labels ?? labelsFor(plan);
    let failed = false;
    for (const operation of [
      () => this.removeOwnedContainer(plan.names.sandbox, labels),
      () => this.removeOwnedContainer(plan.names.gateway, labels),
      () => this.removeOwnedNetwork(plan.names.internalNetwork, labels),
      () => this.removeOwnedNetwork(plan.names.egressNetwork, labels),
    ]) {
      try { await operation(); } catch { failed = true; }
    }
    try { await this.verifyAbsent(plan); } catch { failed = true; }
    if (failed) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    this.resources.delete(plan.invocationId);
  }

  async removeOwnedContainer(name, labels) {
    let inspect;
    try {
      inspect = await this.docker.inspectContainer(name);
    } catch (error) {
      if (error instanceof DockerClientError && error.kind === "not_found") return;
      throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    }
    if (
      inspect?.Config?.Labels?.[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value ||
      inspect?.Config?.Labels?.[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value ||
      inspect?.Config?.Labels?.[INVOCATION_LABEL_KEY] !== labels[INVOCATION_LABEL_KEY]
    ) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    try {
      await this.docker.removeContainer(name);
    } catch {
      throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    }
  }

  async removeOwnedNetwork(name, labels) {
    let inspect;
    try {
      inspect = await this.docker.inspectNetwork(name);
    } catch (error) {
      if (error instanceof DockerClientError && error.kind === "not_found") return;
      throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    }
    if (
      inspect?.Labels?.[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value ||
      inspect?.Labels?.[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value ||
      inspect?.Labels?.[INVOCATION_LABEL_KEY] !== labels[INVOCATION_LABEL_KEY]
    ) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    try {
      await this.docker.removeNetwork(name);
    } catch {
      throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    }
  }

  async verifyAbsent(plan) {
    for (const [kind, name] of [
      ["container", plan.names.sandbox], ["container", plan.names.gateway],
      ["network", plan.names.internalNetwork], ["network", plan.names.egressNetwork],
    ]) {
      try {
        if (kind === "container") await this.docker.inspectContainer(name); else await this.docker.inspectNetwork(name);
        throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
      } catch (error) {
        if (error instanceof DockerClientError && error.kind === "not_found") continue;
        throw error;
      }
    }
  }

  async assertSingleActiveSupervisor() {
    let self;
    let containers;
    try {
      self = await this.docker.inspectContainer(this.selfContainerName);
      containers = await this.docker.listContainers(`${SUPERVISOR_OWNER_LABEL.key}=${SUPERVISOR_OWNER_LABEL.value}`);
    } catch {
      throw unavailable();
    }
    const selfLabels = self?.Config?.Labels ?? {};
    if (
      typeof self?.Id !== "string" || self.Id.length === 0 ||
      self?.State?.Running !== true ||
      selfLabels[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value ||
      selfLabels[SUPERVISOR_SERVICE_RESOURCE_LABEL.key] !== SUPERVISOR_SERVICE_RESOURCE_LABEL.value
    ) {
      throw unavailable();
    }
    const runningSupervisors = (containers ?? []).filter((container) => {
      const labels = container?.Labels ?? {};
      return container?.State === "running" &&
        labels[SUPERVISOR_OWNER_LABEL.key] === SUPERVISOR_OWNER_LABEL.value &&
        labels[SUPERVISOR_SERVICE_RESOURCE_LABEL.key] === SUPERVISOR_SERVICE_RESOURCE_LABEL.value;
    });
    if (runningSupervisors.length !== 1 || runningSupervisors[0]?.Id !== self.Id) {
      throw unavailable();
    }
    return self.Id;
  }

  async cleanupOrphans() {
    await this.assertSingleActiveSupervisor();
    const filter = `${SUPERVISOR_OWNER_LABEL.key}=${SUPERVISOR_OWNER_LABEL.value}`;
    let failed = false;
    const containers = await this.docker.listContainers(filter);
    for (const container of containers ?? []) {
      const labels = container?.Labels ?? {};
      if (
        labels[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value ||
        labels[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value
      ) continue;
      try { await this.docker.removeContainer(container.Id); } catch { failed = true; }
    }
    const networks = await this.docker.listNetworks(filter);
    for (const network of networks ?? []) {
      if (
        network?.Labels?.[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value ||
        network?.Labels?.[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value
      ) continue;
      try { await this.docker.removeNetwork(network.Id); } catch { failed = true; }
    }
    if (failed) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
}

export const supervisorContainerConfigurations = Object.freeze({
  gateway: gatewayContainerConfiguration,
  sandbox: sandboxContainerConfiguration,
  network: networkConfiguration,
});
