import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import net, { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, normalize } from "node:path/posix";

import {
  EGRESS_BROKER_CONTROL_TIMEOUT_MS,
  EGRESS_BROKER_MAX_CONTROL_BYTES,
  EGRESS_BROKER_MAX_CONTROL_CONNECTIONS,
  EGRESS_BROKER_MAX_POLICIES,
  EGRESS_BROKER_MAX_POLICY_TTL_MS,
  EGRESS_BROKER_POLICY_CLEANUP_MARGIN_MS,
  EGRESS_BROKER_PROTOCOL_VERSION,
  EGRESS_BROKER_SOCKET_DIRECTORY,
  EGRESS_BROKER_SOCKET_MODE,
  EGRESS_BROKER_SOCKET_PATH,
} from "./egress-broker-constants.mjs";
import { PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HEALTH_KEYS = Object.freeze(["operation", "protocolVersion"]);
const REGISTER_KEYS = Object.freeze([
  "brokerLocalAddress", "capabilityId", "capabilityVersion", "invocationId",
  "mode", "operation", "protocolVersion", "requestId",
]);
const REVOKE_KEYS = Object.freeze(["brokerLocalAddress", "invocationId", "operation", "protocolVersion"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  return actual.length === reviewed.length && actual.every((key, index) => key === reviewed[index]);
}

function controlFailure() {
  return new PieceRuntimeError("PIECE_EGRESS_DENIED");
}

function exactSocketPath(value) {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value &&
    dirname(value) === EGRESS_BROKER_SOCKET_DIRECTORY && basename(value) === basename(EGRESS_BROKER_SOCKET_PATH);
}

export function validateEgressBrokerSocketPath(value) {
  if (!exactSocketPath(value)) throw controlFailure();
  return value;
}

export function currentInterfaceAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (typeof entry?.address === "string" && isIP(entry.address) !== 0) addresses.push(entry.address);
    }
  }
  return new Set(addresses);
}

export function validateBrokerControlMessage(value) {
  const message = record(value);
  if (!message || message.protocolVersion !== EGRESS_BROKER_PROTOCOL_VERSION || typeof message.operation !== "string") {
    throw controlFailure();
  }
  if (message.operation === "health") {
    if (!exactKeys(message, HEALTH_KEYS)) throw controlFailure();
    return message;
  }
  if (message.operation === "register") {
    if (
      !exactKeys(message, REGISTER_KEYS) ||
      !IDENTITY.test(message.invocationId) ||
      !IDENTITY.test(message.requestId) ||
      !IDENTITY.test(message.capabilityId) ||
      !Number.isSafeInteger(message.capabilityVersion) ||
      message.capabilityVersion < 1 ||
      message.mode !== "TEST" ||
      typeof message.brokerLocalAddress !== "string" ||
      isIP(message.brokerLocalAddress) === 0
    ) throw controlFailure();
    return message;
  }
  if (message.operation === "revoke") {
    if (
      !exactKeys(message, REVOKE_KEYS) ||
      !IDENTITY.test(message.invocationId) ||
      typeof message.brokerLocalAddress !== "string" ||
      isIP(message.brokerLocalAddress) === 0
    ) throw controlFailure();
    return message;
  }
  throw controlFailure();
}

export class EgressBrokerPolicyStore {
  /** @param {{manifests?: *, resolveDestination?: Function, baselineAddresses?: Set<string>, listInterfaceAddresses?: Function, now?: Function, logger?: Function}} options */
  constructor({
    manifests = REVIEWED_MANIFESTS,
    resolveDestination,
    baselineAddresses,
    listInterfaceAddresses = currentInterfaceAddresses,
    now = Date.now,
    logger = () => undefined,
  } = {}) {
    if (typeof resolveDestination !== "function" || !(baselineAddresses instanceof Set)) throw controlFailure();
    this.manifests = manifests;
    this.resolveDestination = resolveDestination;
    this.baselineAddresses = new Set(baselineAddresses);
    this.listInterfaceAddresses = listInterfaceAddresses;
    this.now = now;
    this.logger = logger;
    this.policies = new Map();
  }

  pruneExpired() {
    const time = this.now();
    for (const [address, policy] of this.policies) {
      if (policy.expiresAt <= time) this.policies.delete(address);
    }
  }

  health() {
    this.pruneExpired();
    return Object.freeze({
      ok: true,
      protocolVersion: EGRESS_BROKER_PROTOCOL_VERSION,
      operation: "health",
      status: "ready",
      activePolicies: this.policies.size,
    });
  }

  async register(rawMessage) {
    const message = validateBrokerControlMessage(rawMessage);
    if (message.operation !== "register") throw controlFailure();
    this.pruneExpired();
    const currentAddresses = this.listInterfaceAddresses();
    if (!(currentAddresses instanceof Set) || !currentAddresses.has(message.brokerLocalAddress) || this.baselineAddresses.has(message.brokerLocalAddress)) {
      throw controlFailure();
    }
    const existing = this.policies.get(message.brokerLocalAddress);
    if (existing) {
      const same = existing.invocationId === message.invocationId && existing.requestId === message.requestId &&
        existing.capabilityId === message.capabilityId && existing.capabilityVersion === message.capabilityVersion;
      if (!same) throw controlFailure();
      return this.registrationAcknowledgement(existing);
    }
    if (this.policies.size >= EGRESS_BROKER_MAX_POLICIES) throw controlFailure();
    let manifest;
    try {
      manifest = this.manifests.get(message.capabilityId, message.capabilityVersion);
    } catch {
      throw controlFailure();
    }
    if (manifest.operationClassification !== "READ" || message.mode !== "TEST" || !manifest.modes.includes("TEST")) {
      throw controlFailure();
    }
    const destinations = [];
    try {
      for (const destination of manifest.destinations) {
        const resolved = await this.resolveDestination(destination);
        destinations.push(Object.freeze({
          hostname: destination.hostname,
          port: destination.port,
          pinnedAddress: resolved.pinnedAddress,
          family: resolved.family,
          evidence: resolved.evidence,
        }));
      }
    } catch {
      throw controlFailure();
    }
    const ttlMs = Math.min(
      EGRESS_BROKER_MAX_POLICY_TTL_MS,
      manifest.resourceLimits.lifetimeTimeoutMs + EGRESS_BROKER_POLICY_CLEANUP_MARGIN_MS,
    );
    const policy = {
      invocationId: message.invocationId,
      requestId: message.requestId,
      capabilityId: message.capabilityId,
      capabilityVersion: message.capabilityVersion,
      brokerLocalAddress: message.brokerLocalAddress,
      destinations: Object.freeze(destinations),
      limits: Object.freeze({
        clientHelloBytes: 16 * 1024,
        maximumProviderUpstreamBytes: manifest.maximumProviderUpstreamBytes,
        maximumProviderDownstreamBytes: manifest.maximumProviderDownstreamBytes,
        connectTimeoutMs: manifest.resourceLimits.connectTimeoutMs,
        idleTimeoutMs: manifest.resourceLimits.idleTimeoutMs,
        lifetimeTimeoutMs: manifest.resourceLimits.lifetimeTimeoutMs,
        simultaneousConnections: manifest.resourceLimits.simultaneousConnections,
      }),
      expiresAt: this.now() + ttlMs,
      activeConnections: 0,
    };
    this.policies.set(message.brokerLocalAddress, policy);
    this.safeLog("piece_egress_broker_policy_registered", policy, "REGISTERED", policy.destinations.map(({ hostname, port, evidence }) => ({ hostname, port, evidence })));
    return this.registrationAcknowledgement(policy);
  }

  registrationAcknowledgement(policy) {
    return Object.freeze({
      ok: true,
      protocolVersion: EGRESS_BROKER_PROTOCOL_VERSION,
      operation: "register",
      invocationId: policy.invocationId,
      expiresAt: policy.expiresAt,
      destinations: policy.destinations.map(({ hostname, port, evidence }) => ({ hostname, port, evidence })),
    });
  }

  revoke(rawMessage) {
    const message = validateBrokerControlMessage(rawMessage);
    if (message.operation !== "revoke") throw controlFailure();
    this.pruneExpired();
    const policy = this.policies.get(message.brokerLocalAddress);
    if (policy && policy.invocationId !== message.invocationId) throw controlFailure();
    if (policy) this.policies.delete(message.brokerLocalAddress);
    this.safeLog("piece_egress_broker_policy_revoked", policy ?? message, "REVOKED");
    return Object.freeze({
      ok: true,
      protocolVersion: EGRESS_BROKER_PROTOCOL_VERSION,
      operation: "revoke",
      invocationId: message.invocationId,
    });
  }

  authorize(localAddress, hostname) {
    this.pruneExpired();
    const policy = this.policies.get(localAddress);
    if (!policy || policy.expiresAt <= this.now() || policy.activeConnections >= policy.limits.simultaneousConnections) {
      throw controlFailure();
    }
    const destination = policy.destinations.find((candidate) => candidate.hostname === hostname);
    if (!destination || isIP(hostname) !== 0) throw controlFailure();
    policy.activeConnections += 1;
    let released = false;
    return Object.freeze({
      invocationId: policy.invocationId,
      requestId: policy.requestId,
      capabilityId: policy.capabilityId,
      destination,
      limits: policy.limits,
      release: () => {
        if (released) return;
        released = true;
        policy.activeConnections = Math.max(0, policy.activeConnections - 1);
      },
    });
  }

  safeLog(event, policy, outcome, destinations = undefined) {
    try {
      this.logger(Object.freeze({
        event,
        invocationId: policy?.invocationId ?? null,
        requestId: policy?.requestId ?? null,
        capabilityId: policy?.capabilityId ?? null,
        outcome,
        ...(destinations === undefined ? {} : { destinations }),
      }));
    } catch {}
  }
}

function activeSocket(path) {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 250);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function claimSocket(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (existsSync(path)) {
    const status = statSync(path);
    if (!status.isSocket() || await activeSocket(path)) throw controlFailure();
    unlinkSync(path);
  }
}

function safeResponse(value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > EGRESS_BROKER_MAX_CONTROL_BYTES) throw controlFailure();
  return serialized;
}

const productionSocketLifecycle = Object.freeze({
  async claim(path) { await claimSocket(path); },
  secure(path) { chmodSync(path, EGRESS_BROKER_SOCKET_MODE); },
  remove(path) { if (existsSync(path)) unlinkSync(path); },
});

/**
 * @param {{
 *   policyStore?: EgressBrokerPolicyStore,
 *   socketPath?: string,
 *   socketPathValidator?: Function,
 *   socketLifecycle?: {claim: Function, secure: Function, remove: Function}
 * }} options
 */
export async function startEgressBrokerControlServer({
  policyStore,
  socketPath = EGRESS_BROKER_SOCKET_PATH,
  socketPathValidator = validateEgressBrokerSocketPath,
  socketLifecycle = productionSocketLifecycle,
} = {}) {
  if (!(policyStore instanceof EgressBrokerPolicyStore)) throw controlFailure();
  if (
    typeof socketPathValidator !== "function" || socketPathValidator(socketPath) !== socketPath ||
    !socketLifecycle || typeof socketLifecycle.claim !== "function" ||
    typeof socketLifecycle.secure !== "function" || typeof socketLifecycle.remove !== "function"
  ) throw controlFailure();
  await socketLifecycle.claim(socketPath);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(EGRESS_BROKER_CONTROL_TIMEOUT_MS, () => socket.destroy());
    let chunks = [];
    let bytes = 0;
    let handled = false;
    const clear = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; bytes = 0; };
    const fail = () => {
      if (handled) return;
      handled = true;
      try { socket.end(safeResponse({ ok: false, protocolVersion: 1, errorCode: "PIECE_EGRESS_DENIED" })); } catch { socket.destroy(); }
      clear();
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      if (bytes + chunk.length > EGRESS_BROKER_MAX_CONTROL_BYTES) return fail();
      bytes += chunk.length;
      chunks.push(Buffer.from(chunk));
      if (!chunk.includes(10)) return;
      const raw = Buffer.concat(chunks, bytes);
      handled = true;
      try {
        const text = raw.toString("utf8");
        if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw controlFailure();
        const message = validateBrokerControlMessage(JSON.parse(text.slice(0, -1)));
        const response = message.operation === "health"
          ? policyStore.health()
          : message.operation === "register"
            ? policyStore.register(message)
            : policyStore.revoke(message);
        Promise.resolve(response).then(
          (result) => socket.end(safeResponse(result)),
          () => socket.end(safeResponse({ ok: false, protocolVersion: 1, errorCode: "PIECE_EGRESS_DENIED" })),
        );
      } catch {
        socket.end(safeResponse({ ok: false, protocolVersion: 1, errorCode: "PIECE_EGRESS_DENIED" }));
      } finally {
        raw.fill(0);
        clear();
      }
    });
    socket.once("error", clear);
    socket.once("close", () => { sockets.delete(socket); clear(); });
  });
  server.maxConnections = EGRESS_BROKER_MAX_CONTROL_CONNECTIONS;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  socketLifecycle.secure(socketPath);
  return Object.freeze({
    server,
    socketPath,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      socketLifecycle.remove(socketPath);
    },
  });
}
