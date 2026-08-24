import { createServer, connect as connectTcp } from "node:net";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { EGRESS_LIMITS, PROVIDER_MANIFEST } from "./provider-manifest.mjs";
import { isSafePublicAddress } from "./ip-policy.mjs";

const requestId = process.env.E50_REQUEST_ID ?? "unknown";
const resolverScenario = process.env.E50_RESOLVER_SCENARIO ?? "safe";
const destination = PROVIDER_MANIFEST.destinations[0];
const SAFE_TEST_ADDRESS = "93.184.216.34";
let activeConnections = 0;
let resolutionCount = 0;

function runtimeStatus() {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1]?.trim() ?? null;
  return {
    event: "gateway_runtime",
    uid: process.getuid?.() ?? null,
    seccomp: field("Seccomp"),
    capabilities: field("CapEff"),
    noNewPrivileges: field("NoNewPrivs")
  };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function resolveApprovedDestination() {
  resolutionCount += 1;
  if (resolverScenario === "dns_failure") throw new Error("EGRESS_DNS_FAILED");
  if (resolverScenario === "private") return ["10.0.0.8"];
  if (resolverScenario === "metadata") return ["169.254.169.254"];
  if (resolverScenario === "ipv6_private") return ["fc00::8"];
  if (resolverScenario === "rebind" && resolutionCount > 1) return ["192.168.1.8"];
  return [SAFE_TEST_ADDRESS];
}

function parseSni(buffer) {
  if (buffer.length < 5) return { pending: true };
  if (buffer[0] !== 22) return { error: "EGRESS_PROTOCOL_INVALID" };
  const recordLength = buffer.readUInt16BE(3);
  if (recordLength > EGRESS_LIMITS.clientHelloBytes - 5) return { error: "EGRESS_PROTOCOL_INVALID" };
  if (buffer.length < 5 + recordLength) return { pending: true };
  let offset = 5;
  if (buffer[offset] !== 1) return { error: "EGRESS_PROTOCOL_INVALID" };
  offset += 4 + 2 + 32;
  if (offset >= buffer.length) return { error: "EGRESS_PROTOCOL_INVALID" };
  offset += 1 + buffer[offset];
  if (offset + 2 > buffer.length) return { error: "EGRESS_PROTOCOL_INVALID" };
  offset += 2 + buffer.readUInt16BE(offset);
  if (offset >= buffer.length) return { error: "EGRESS_PROTOCOL_INVALID" };
  offset += 1 + buffer[offset];
  if (offset + 2 > buffer.length) return { error: "EGRESS_TLS_POLICY_DENIED" };
  const extensionsEnd = offset + 2 + buffer.readUInt16BE(offset);
  offset += 2;
  if (extensionsEnd > buffer.length) return { error: "EGRESS_PROTOCOL_INVALID" };
  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { error: "EGRESS_PROTOCOL_INVALID" };
    if (type === 0 && length >= 5) {
      const nameType = buffer[offset + 2];
      const nameLength = buffer.readUInt16BE(offset + 3);
      if (nameType !== 0 || nameLength < 1 || nameLength + 5 > length) return { error: "EGRESS_TLS_POLICY_DENIED" };
      const hostname = buffer.subarray(offset + 5, offset + 5 + nameLength).toString("ascii").toLowerCase();
      return { hostname };
    }
    offset += length;
  }
  return { error: "EGRESS_TLS_POLICY_DENIED" };
}

function handleClient(client) {
  const started = performance.now();
  let clientHello = Buffer.alloc(0);
  let upstream = null;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let completed = false;
  let handshakeTimer;
  let connectTimer;
  let lifetimeTimer;
  activeConnections += 1;

  const finish = (outcome) => {
    if (completed) return;
    completed = true;
    clearTimeout(handshakeTimer);
    clearTimeout(connectTimer);
    clearTimeout(lifetimeTimer);
    activeConnections = Math.max(0, activeConnections - 1);
    client.destroy();
    upstream?.destroy();
    emit({
      event: "gateway_connection",
      requestId,
      capability: PROVIDER_MANIFEST.capability,
      hostname: destination.hostname,
      port: destination.port,
      durationMs: Number((performance.now() - started).toFixed(2)),
      upstreamBytes,
      downstreamBytes,
      outcome
    });
  };

  if (activeConnections > EGRESS_LIMITS.simultaneousConnections) {
    finish("EGRESS_CONNECTION_FAILED");
    return;
  }

  client.setTimeout(EGRESS_LIMITS.idleMs, () => finish("EGRESS_TIMEOUT"));
  lifetimeTimer = setTimeout(() => finish("EGRESS_TIMEOUT"), EGRESS_LIMITS.lifetimeMs);
  handshakeTimer = setTimeout(() => finish("EGRESS_TIMEOUT"), EGRESS_LIMITS.handshakeMs);

  client.on("data", (chunk) => {
    upstreamBytes += chunk.length;
    if (upstreamBytes > EGRESS_LIMITS.upstreamBytes) return finish("EGRESS_TRANSFER_LIMIT");
    if (upstream) {
      upstream.write(chunk);
      return;
    }
    clientHello = Buffer.concat([clientHello, chunk]);
    if (clientHello.length > EGRESS_LIMITS.clientHelloBytes) return finish("EGRESS_PROTOCOL_INVALID");
    const parsed = parseSni(clientHello);
    if (parsed.pending) return;
    if (parsed.error) return finish(parsed.error);
    if (parsed.hostname !== destination.hostname) return finish("EGRESS_TLS_POLICY_DENIED");
    clearTimeout(handshakeTimer);

    let addresses;
    try {
      addresses = resolveApprovedDestination();
    } catch {
      return finish("EGRESS_DNS_FAILED");
    }
    if (!Array.isArray(addresses) || addresses.length === 0) return finish("EGRESS_DNS_FAILED");
    if (!addresses.every(isSafePublicAddress)) return finish("EGRESS_DNS_DENIED");
    const pinnedAddress = addresses[0];
    upstream = connectTcp({ host: pinnedAddress, port: destination.port });
    connectTimer = setTimeout(() => finish("EGRESS_CONNECTION_FAILED"), EGRESS_LIMITS.connectMs);
    upstream.setTimeout(EGRESS_LIMITS.idleMs, () => finish("EGRESS_TIMEOUT"));
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      upstream.write(clientHello);
      clientHello = Buffer.alloc(0);
    });
    upstream.on("data", (data) => {
      downstreamBytes += data.length;
      if (downstreamBytes > EGRESS_LIMITS.downstreamBytes) return finish("EGRESS_TRANSFER_LIMIT");
      client.write(data);
    });
    upstream.once("error", () => finish("EGRESS_CONNECTION_FAILED"));
    upstream.once("end", () => finish("EGRESS_SUCCEEDED"));
  });
  client.once("error", () => finish(upstream ? "EGRESS_CONNECTION_FAILED" : "EGRESS_PROTOCOL_INVALID"));
  client.once("end", () => finish(upstream ? "EGRESS_SUCCEEDED" : "EGRESS_PROTOCOL_INVALID"));
}

emit(runtimeStatus());
createServer(handleClient).listen(destination.port, "0.0.0.0", () => {
  emit({ event: "gateway_ready", capability: PROVIDER_MANIFEST.capability, hostname: destination.hostname, port: destination.port });
});
