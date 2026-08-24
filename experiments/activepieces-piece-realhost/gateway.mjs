import { createServer, connect as connectTcp } from "node:net";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { EGRESS_LIMITS, PROVIDER_MANIFEST } from "./provider-manifest.mjs";
import { isSafePublicAddress } from "./ip-policy.mjs";
import { resolveApprovedHostname } from "./real-dns.mjs";

const requestId = process.env.E50_REQUEST_ID ?? "unknown";
const resolverMode = process.env.E50_RESOLVER_MODE ?? "fixture:safe";
const fixtureAddress = process.env.E50_MOCK_ADDRESS ?? "93.184.216.34";
const destination = PROVIDER_MANIFEST.destinations[0];
let activeConnections = 0;
let resolutionCount = 0;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function runtimeStatus() {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1]?.trim() ?? null;
  return {
    event: "gateway_runtime",
    uid: process.getuid?.() ?? null,
    seccomp: field("Seccomp"),
    capabilities: field("CapEff"),
    noNewPrivileges: field("NoNewPrivs"),
  };
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
      return { hostname: buffer.subarray(offset + 5, offset + 5 + nameLength).toString("ascii").toLowerCase() };
    }
    offset += length;
  }
  return { error: "EGRESS_TLS_POLICY_DENIED" };
}

function fixtureResolution() {
  resolutionCount += 1;
  const scenario = resolverMode.slice("fixture:".length);
  if (scenario === "dns_failure") throw Object.assign(new Error("dns failure"), { category: "EGRESS_DNS_FAILED" });
  if (scenario === "timeout") throw Object.assign(new Error("dns timeout"), { category: "EGRESS_TIMEOUT" });
  const address =
    scenario === "private" ? "10.0.0.8" :
    scenario === "metadata" ? "169.254.169.254" :
    scenario === "ipv6_private" ? "fc00::8" :
    scenario === "rebind" && resolutionCount > 1 ? "192.168.1.8" : fixtureAddress;
  if (!isSafePublicAddress(address)) throw Object.assign(new Error("unsafe DNS"), { category: "EGRESS_DNS_DENIED" });
  return { pinnedAddress: address, family: address.includes(":") ? 6 : 4, evidence: [{ family: address.includes(":") ? 6 : 4, ttl: 60, classification: "SAFE" }] };
}

async function resolveDestination() {
  if (resolverMode === "real") return resolveApprovedHostname({ hostname: destination.hostname, timeoutMs: EGRESS_LIMITS.connectMs });
  if (!resolverMode.startsWith("fixture:")) throw Object.assign(new Error("invalid resolver mode"), { category: "EGRESS_DNS_FAILED" });
  return fixtureResolution();
}

function handleClient(client) {
  const started = performance.now();
  let buffered = Buffer.alloc(0);
  let upstream = null;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let completed = false;
  let policyPending = false;
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
      provider: "hubspot",
      hostname: destination.hostname,
      port: destination.port,
      durationMs: Number((performance.now() - started).toFixed(2)),
      upstreamBytes,
      downstreamBytes,
      outcome,
    });
  };

  if (activeConnections > EGRESS_LIMITS.simultaneousConnections) return finish("EGRESS_CONNECTION_FAILED");
  client.setTimeout(EGRESS_LIMITS.idleMs, () => finish("EGRESS_TIMEOUT"));
  lifetimeTimer = setTimeout(() => finish("EGRESS_TIMEOUT"), EGRESS_LIMITS.lifetimeMs);
  handshakeTimer = setTimeout(() => finish("EGRESS_TIMEOUT"), EGRESS_LIMITS.handshakeMs);

  const establish = async () => {
    let resolved;
    try {
      resolved = await resolveDestination();
    } catch (error) {
      return finish(error?.category ?? "EGRESS_DNS_FAILED");
    }
    for (const evidence of resolved.evidence) {
      emit({ event: "gateway_dns", requestId, hostname: destination.hostname, recordType: evidence.family === 4 ? "A" : "AAAA", classification: evidence.classification, ttl: evidence.ttl });
    }
    upstream = connectTcp({ host: resolved.pinnedAddress, port: destination.port, family: resolved.family });
    connectTimer = setTimeout(() => finish("EGRESS_CONNECTION_FAILED"), EGRESS_LIMITS.connectMs);
    upstream.setTimeout(EGRESS_LIMITS.idleMs, () => finish("EGRESS_TIMEOUT"));
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      upstream.write(buffered);
      buffered = Buffer.alloc(0);
      client.resume();
    });
    upstream.on("data", (data) => {
      downstreamBytes += data.length;
      if (downstreamBytes > EGRESS_LIMITS.downstreamBytes) return finish("EGRESS_TRANSFER_LIMIT");
      client.write(data);
    });
    upstream.once("error", () => finish("EGRESS_CONNECTION_FAILED"));
    upstream.once("end", () => finish("EGRESS_SUCCEEDED"));
  };

  client.on("data", (chunk) => {
    upstreamBytes += chunk.length;
    if (upstreamBytes > EGRESS_LIMITS.upstreamBytes) return finish("EGRESS_TRANSFER_LIMIT");
    if (upstream) return void upstream.write(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > EGRESS_LIMITS.clientHelloBytes) return finish("EGRESS_PROTOCOL_INVALID");
    if (policyPending) return;
    const parsed = parseSni(buffered);
    if (parsed.pending) return;
    if (parsed.error) return finish(parsed.error);
    if (parsed.hostname !== destination.hostname) return finish("EGRESS_TLS_POLICY_DENIED");
    policyPending = true;
    clearTimeout(handshakeTimer);
    client.pause();
    void establish();
  });
  client.once("error", () => finish(upstream ? "EGRESS_CONNECTION_FAILED" : "EGRESS_PROTOCOL_INVALID"));
  client.once("end", () => finish(upstream ? "EGRESS_SUCCEEDED" : "EGRESS_PROTOCOL_INVALID"));
}

emit(runtimeStatus());
createServer(handleClient).listen(destination.port, "0.0.0.0", () => {
  emit({ event: "gateway_ready", capability: PROVIDER_MANIFEST.capability, provider: "hubspot", hostname: destination.hostname, port: destination.port, resolverMode: resolverMode === "real" ? "real" : "fixture" });
});
