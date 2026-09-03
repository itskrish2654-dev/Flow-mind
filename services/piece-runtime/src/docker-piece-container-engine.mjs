import { isIP } from "node:net";

import { PieceContainerEngine } from "./container-engine.mjs";
import { DockerClientError } from "./docker-client.mjs";
import { EgressBrokerClient } from "./egress-broker-client.mjs";
import { EGRESS_BROKER_CONTAINER_NAME, EGRESS_BROKER_LABELS, EGRESS_BROKER_SOCKET_PATH } from "./egress-broker-constants.mjs";
import { PIECE_ERROR_CODES, PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import { SUPERVISOR_INVOCATION_RESOURCE_LABEL, SUPERVISOR_OWNER_LABEL, SUPERVISOR_SERVICE_RESOURCE_LABEL } from "./supervisor-constants.mjs";
import { SupervisorError } from "./supervisor-errors.mjs";

const INVOCATION_LABEL_KEY = "crazyloops.invocation";
const DOCKER_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function validatedSelfContainerName(value) {
  if (typeof value !== "string" || !DOCKER_CONTAINER_NAME.test(value)) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
  return value;
}

export function validatedBrokerContainerName(value = EGRESS_BROKER_CONTAINER_NAME) {
  if (value !== EGRESS_BROKER_CONTAINER_NAME) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
  return value;
}

function unavailable() { return new SupervisorError("SUPERVISOR_UNAVAILABLE", 503); }
function nanoCpus(cpus) { return Math.round(cpus * 1_000_000_000); }
function ulimit(value) { const [Soft, Hard] = value.split(":").map(Number); return [{ Name: "nofile", Soft, Hard }]; }
function labelsFor(plan) {
  return {
    [SUPERVISOR_OWNER_LABEL.key]: SUPERVISOR_OWNER_LABEL.value,
    [SUPERVISOR_INVOCATION_RESOURCE_LABEL.key]: SUPERVISOR_INVOCATION_RESOURCE_LABEL.value,
    [INVOCATION_LABEL_KEY]: plan.invocationId,
  };
}
function securityOptions(value) { return value ? ["no-new-privileges"] : []; }
function validBrokerAddress(value) {
  return typeof value === "string" && isIP(value) !== 0 && !["0.0.0.0", "::", "127.0.0.1", "::1"].includes(value);
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort(); const reviewed = [...expected].sort();
  return actual.length === reviewed.length && actual.every((key, index) => key === reviewed[index]);
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null; }

function safeWorkerResult(buffer, requestId, maximumBytes, manifest) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > maximumBytes) throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw new Error("invalid line count");
    const value = JSON.parse(lines[0]);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.protocolVersion !== 1 || value.requestId !== requestId || typeof value.ok !== "boolean") throw new Error("invalid worker result");
    if (value.ok === true) {
      if (!exactKeys(value, ["acknowledged", "meta", "ok", "output", "protocolVersion", "requestId"])) throw new Error("invalid success result");
      const output = record(value.output); const meta = record(value.meta);
      if (value.acknowledged !== true || !output || !meta ||
        !exactKeys(meta, ["capabilityId", "capabilityVersion", "providerId", "pieceVersion", "actionId", "classification", "attempts"]) ||
        meta.capabilityId !== manifest.capabilityId || meta.capabilityVersion !== manifest.capabilityVersion || meta.providerId !== manifest.providerId ||
        meta.pieceVersion !== manifest.pieceVersion || meta.actionId !== manifest.actionId || meta.classification !== manifest.operationClassification || meta.attempts !== 1) throw new Error("invalid success result");
    } else if (!exactKeys(value, ["errorCode", "ok", "protocolVersion", "requestId", "retryable"]) || !PIECE_ERROR_CODES.includes(value.errorCode) || typeof value.retryable !== "boolean") {
      throw new Error("invalid failure result");
    }
    return value;
  } catch (error) {
    if (error instanceof PieceRuntimeError) throw error;
    throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
  } finally { if (Buffer.isBuffer(buffer)) buffer.fill(0); }
}

function sandboxContainerConfiguration(plan, labels, brokerAddress) {
  const tmpfs = plan.sandbox.tmpfs.split(":");
  return {
    Image: plan.images.sandbox, User: plan.sandbox.user,
    AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true, Tty: false,
    Env: [], Labels: labels,
    HostConfig: {
      NetworkMode: plan.names.internalNetwork, ReadonlyRootfs: plan.sandbox.readOnlyRoot,
      Tmpfs: { [tmpfs[0]]: tmpfs.slice(1).join(":") }, CapDrop: plan.sandbox.capDrop,
      SecurityOpt: securityOptions(plan.sandbox.noNewPrivileges), PidsLimit: plan.sandbox.pidsLimit,
      Memory: plan.sandbox.memoryBytes, MemorySwap: plan.sandbox.memorySwapBytes, NanoCpus: nanoCpus(plan.sandbox.cpus),
      Ulimits: ulimit(plan.sandbox.nofile), Mounts: [], PortBindings: {}, PublishAllPorts: false, Privileged: false,
      LogConfig: { Type: "none", Config: {} },
      ExtraHosts: plan.sandbox.canonicalHostMappings.map(({ hostname }) => `${hostname}:${brokerAddress}`),
    },
    NetworkingConfig: { EndpointsConfig: { [plan.names.internalNetwork]: {} } },
  };
}

function networkConfiguration(name, internal, labels) {
  return { Name: name, CheckDuplicate: true, Driver: "bridge", Internal: internal, Attachable: false, Ingress: false, Labels: labels, Options: {} };
}
function mapDockerFailure(error) {
  if (error instanceof PieceRuntimeError) return error;
  if (error instanceof DockerClientError && error.kind === "timeout") return new PieceRuntimeError("PIECE_TIMEOUT", true);
  if (error instanceof DockerClientError && error.kind === "stdout_limit") return new PieceRuntimeError("PIECE_RESPONSE_INVALID");
  return new PieceRuntimeError("PIECE_RUNTIME_FAILED");
}

function validRegistrationAcknowledgement(value, plan, manifest) {
  if (!value || !exactKeys(value, ["destinations", "expiresAt", "invocationId", "ok", "operation", "protocolVersion"]) ||
    value.ok !== true || value.protocolVersion !== 1 || value.operation !== "register" || value.invocationId !== plan.invocationId ||
    !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 15_000 || !Array.isArray(value.destinations)) return false;
  if (value.destinations.length !== manifest.destinations.length) return false;
  return value.destinations.every((destination, index) => {
    const reviewed = manifest.destinations[index];
    return destination && exactKeys(destination, ["evidence", "hostname", "port"]) && destination.hostname === reviewed.hostname &&
      destination.port === reviewed.port && Array.isArray(destination.evidence) && destination.evidence.length > 0 &&
      destination.evidence.every((evidence) => evidence && exactKeys(evidence, ["classification", "family", "ttl"]) &&
        evidence.classification === "SAFE" && [4, 6].includes(evidence.family) && Number.isInteger(evidence.ttl));
  });
}

export class DockerPieceContainerEngine extends PieceContainerEngine {
  /** @param {{docker?: *, brokerClient?: *, logger?: Function, selfContainerName?: string, brokerContainerName?: string}} options */
  constructor({ docker, brokerClient = new EgressBrokerClient({ socketPath: process.env.PIECE_EGRESS_BROKER_SOCKET_PATH ?? EGRESS_BROKER_SOCKET_PATH }), logger = () => undefined, selfContainerName, brokerContainerName = process.env.PIECE_EGRESS_BROKER_CONTAINER_NAME ?? EGRESS_BROKER_CONTAINER_NAME } = {}) {
    super();
    if (!docker || !brokerClient) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    this.docker = docker; this.brokerClient = brokerClient; this.logger = logger;
    this.selfContainerName = validatedSelfContainerName(selfContainerName);
    this.brokerContainerName = validatedBrokerContainerName(brokerContainerName);
    this.resources = new Map();
  }

  async verifyBroker(expectedId = null) {
    try {
      const broker = await this.docker.inspectContainer(this.brokerContainerName);
      const labels = broker?.Config?.Labels ?? {};
      if (typeof broker?.Id !== "string" || !broker.Id || broker.State?.Running !== true ||
        labels["crazyloops.runtime"] !== EGRESS_BROKER_LABELS["crazyloops.runtime"] || labels["crazyloops.resource"] !== EGRESS_BROKER_LABELS["crazyloops.resource"] ||
        (broker.Name !== undefined && broker.Name !== `/${this.brokerContainerName}`) || (expectedId !== null && broker.Id !== expectedId)) throw unavailable();
      const health = await this.brokerClient.health();
      if (health?.operation !== "health" || health?.status !== "ready") throw unavailable();
      return broker;
    } catch (error) { if (error instanceof SupervisorError) throw error; throw unavailable(); }
  }

  async runInvocation({ plan, request, credential, signal = undefined }) {
    const labels = labelsFor(plan);
    const state = { plan, labels, brokerId: null, brokerLocalAddress: null, internalCreated: false, brokerAttached: false, brokerRegistered: false, sandboxCreated: false };
    this.resources.set(plan.invocationId, state);
    let envelope = null;
    try {
      const manifest = REVIEWED_MANIFESTS.get(request.capabilityId, request.capabilityVersion);
      if (manifest.operationClassification !== "READ" || request.mode !== "TEST" || !manifest.modes.includes(request.mode)) throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
      const brokerBefore = await this.verifyBroker(); state.brokerId = brokerBefore.Id;
      await this.docker.createNetwork(networkConfiguration(plan.names.internalNetwork, true, labels)); state.internalCreated = true;
      await this.docker.connectNetwork(plan.names.internalNetwork, { Container: this.brokerContainerName, EndpointConfig: {} }); state.brokerAttached = true;
      const attached = await this.docker.inspectContainer(this.brokerContainerName);
      const endpoint = attached?.NetworkSettings?.Networks?.[plan.names.internalNetwork];
      const brokerAddress = endpoint?.IPAddress || endpoint?.GlobalIPv6Address;
      if (!validBrokerAddress(brokerAddress)) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
      state.brokerLocalAddress = brokerAddress;
      const registration = await this.brokerClient.register({ plan, request, brokerLocalAddress: brokerAddress });
      if (!validRegistrationAcknowledgement(registration, plan, manifest)) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
      state.brokerRegistered = true;
      await this.docker.createContainer(plan.names.sandbox, sandboxContainerConfiguration(plan, labels, brokerAddress)); state.sandboxCreated = true;
      envelope = Buffer.from(JSON.stringify({ request, credentialBase64: credential.toString("base64") }), "utf8");
      const output = await this.docker.attachAndRun({ name: plan.names.sandbox, input: envelope, maximumStdoutBytes: manifest.maximumResponseBytes + 8 * 1024, timeoutMs: manifest.resourceLimits.executionTimeoutMs + 1_000, signal });
      const brokerAfter = await this.verifyBroker(state.brokerId);
      if (!brokerAfter?.NetworkSettings?.Networks?.[plan.names.internalNetwork]) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
      return safeWorkerResult(output, request.requestId, manifest.maximumResponseBytes + 8 * 1024, manifest);
    } catch (error) { throw mapDockerFailure(error); }
    finally { envelope?.fill(0); }
  }

  async cleanupInvocation(plan) {
    const state = this.resources.get(plan.invocationId); const labels = state?.labels ?? labelsFor(plan); let failed = false;
    if (state?.brokerRegistered && state.brokerLocalAddress) {
      try { await this.brokerClient.revoke({ plan, brokerLocalAddress: state.brokerLocalAddress }); state.brokerRegistered = false; } catch { failed = true; }
    }
    try { await this.removeOwnedContainer(plan.names.sandbox, labels); } catch { failed = true; }
    if (state?.brokerAttached) {
      try { await this.docker.disconnectNetwork(plan.names.internalNetwork, { Container: this.brokerContainerName, Force: false }); state.brokerAttached = false; } catch { failed = true; }
    }
    try { await this.removeOwnedNetwork(plan.names.internalNetwork, labels); } catch { failed = true; }
    try { await this.verifyInvocationAbsent(plan); } catch { failed = true; }
    try {
      const broker = await this.verifyBroker(state?.brokerId ?? null);
      if (broker?.NetworkSettings?.Networks?.[plan.names.internalNetwork]) failed = true;
    } catch { failed = true; }
    if (failed) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    this.resources.delete(plan.invocationId);
  }

  async removeOwnedContainer(name, labels) {
    let inspect;
    try { inspect = await this.docker.inspectContainer(name); }
    catch (error) { if (error instanceof DockerClientError && error.kind === "not_found") return; throw new PieceRuntimeError("PIECE_RUNTIME_FAILED"); }
    if (inspect?.Config?.Labels?.[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value || inspect?.Config?.Labels?.[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value || inspect?.Config?.Labels?.[INVOCATION_LABEL_KEY] !== labels[INVOCATION_LABEL_KEY]) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    try { await this.docker.removeContainer(name); } catch { throw new PieceRuntimeError("PIECE_RUNTIME_FAILED"); }
  }

  async removeOwnedNetwork(name, labels) {
    let inspect;
    try { inspect = await this.docker.inspectNetwork(name); }
    catch (error) { if (error instanceof DockerClientError && error.kind === "not_found") return; throw new PieceRuntimeError("PIECE_RUNTIME_FAILED"); }
    if (inspect?.Labels?.[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value || inspect?.Labels?.[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value || inspect?.Labels?.[INVOCATION_LABEL_KEY] !== labels[INVOCATION_LABEL_KEY]) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    try { await this.docker.removeNetwork(name); } catch { throw new PieceRuntimeError("PIECE_RUNTIME_FAILED"); }
  }

  async verifyInvocationAbsent(plan) {
    for (const [kind, name] of [["container", plan.names.sandbox], ["network", plan.names.internalNetwork]]) {
      try { if (kind === "container") await this.docker.inspectContainer(name); else await this.docker.inspectNetwork(name); throw new PieceRuntimeError("PIECE_RUNTIME_FAILED"); }
      catch (error) { if (error instanceof DockerClientError && error.kind === "not_found") continue; throw error; }
    }
  }

  async assertSingleActiveSupervisor() {
    let self; let containers;
    try { self = await this.docker.inspectContainer(this.selfContainerName); containers = await this.docker.listContainers(`${SUPERVISOR_OWNER_LABEL.key}=${SUPERVISOR_OWNER_LABEL.value}`); }
    catch { throw unavailable(); }
    const labels = self?.Config?.Labels ?? {};
    if (typeof self?.Id !== "string" || !self.Id || self?.State?.Running !== true || labels[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value || labels[SUPERVISOR_SERVICE_RESOURCE_LABEL.key] !== SUPERVISOR_SERVICE_RESOURCE_LABEL.value) throw unavailable();
    const running = (containers ?? []).filter((container) => container?.State === "running" && container?.Labels?.[SUPERVISOR_OWNER_LABEL.key] === SUPERVISOR_OWNER_LABEL.value && container?.Labels?.[SUPERVISOR_SERVICE_RESOURCE_LABEL.key] === SUPERVISOR_SERVICE_RESOURCE_LABEL.value);
    if (running.length !== 1 || running[0]?.Id !== self.Id) throw unavailable();
    return self.Id;
  }

  async cleanupOrphans() {
    await this.assertSingleActiveSupervisor(); await this.verifyBroker();
    const filter = `${SUPERVISOR_OWNER_LABEL.key}=${SUPERVISOR_OWNER_LABEL.value}`; let failed = false;
    for (const container of await this.docker.listContainers(filter) ?? []) {
      const labels = container?.Labels ?? {};
      if (labels[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value || labels[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value) continue;
      try { await this.docker.removeContainer(container.Id); } catch { failed = true; }
    }
    for (const network of await this.docker.listNetworks(filter) ?? []) {
      if (network?.Labels?.[SUPERVISOR_OWNER_LABEL.key] !== SUPERVISOR_OWNER_LABEL.value || network?.Labels?.[SUPERVISOR_INVOCATION_RESOURCE_LABEL.key] !== SUPERVISOR_INVOCATION_RESOURCE_LABEL.value) continue;
      const name = network.Name ?? network.Id;
      try {
        const broker = await this.docker.inspectContainer(this.brokerContainerName); const endpoint = broker?.NetworkSettings?.Networks?.[name];
        if (endpoint) {
          const address = endpoint.IPAddress || endpoint.GlobalIPv6Address; const invocationId = network.Labels?.[INVOCATION_LABEL_KEY];
          if (validBrokerAddress(address) && typeof invocationId === "string") {
            try { await this.brokerClient.revoke({ plan: { invocationId }, brokerLocalAddress: address }); } catch { failed = true; }
          }
          try { await this.docker.disconnectNetwork(name, { Container: this.brokerContainerName, Force: false }); } catch { failed = true; }
        }
        await this.docker.removeNetwork(network.Id);
      } catch { failed = true; }
    }
    if (failed) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
}

export const supervisorContainerConfigurations = Object.freeze({ sandbox: sandboxContainerConfiguration, network: networkConfiguration });
