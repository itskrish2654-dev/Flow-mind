import { readFileSync } from "node:fs";
import { createServer, connect as connectTcp } from "node:net";

import { resolveManifestDestination } from "./dns-policy.mjs";
import { approvedDestinationForHostname, gatewayConnectionEvidence } from "./gateway-evidence.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import { parseTlsClientHello } from "./tls-client-hello.mjs";

const capabilityId = process.env.PIECE_RUNTIME_CAPABILITY_ID ?? "";
const capabilityVersion = Number(process.env.PIECE_RUNTIME_CAPABILITY_VERSION ?? "");
const requestId = process.env.PIECE_RUNTIME_REQUEST_ID ?? "unknown";
const manifest = REVIEWED_MANIFESTS.get(capabilityId, capabilityVersion);
const limits = manifest.resourceLimits;
let activeConnections = 0;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function runtimeEvidence() {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1]?.trim() ?? null;
  return {
    event: "piece_gateway_runtime",
    requestId,
    capabilityId: manifest.capabilityId,
    uid: process.getuid?.() ?? null,
    seccomp: field("Seccomp"),
    capabilities: field("CapEff"),
    noNewPrivileges: field("NoNewPrivs"),
  };
}

function handleClient(client) {
  let clientHello = Buffer.alloc(0);
  let upstream = null;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let completed = false;
  let resolving = false;
  let approvedDestination = null;
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
    clientHello.fill(0);
    client.destroy();
    upstream?.destroy();
    emit(gatewayConnectionEvidence({
      requestId,
      capabilityId: manifest.capabilityId,
      approvedDestination,
      upstreamBytes,
      downstreamBytes,
      outcome,
    }));
  };

  if (activeConnections > limits.simultaneousConnections) return finish("PIECE_EGRESS_DENIED");
  client.setTimeout(limits.idleTimeoutMs, () => finish("PIECE_TIMEOUT"));
  handshakeTimer = setTimeout(() => finish("PIECE_TIMEOUT"), limits.handshakeTimeoutMs);
  lifetimeTimer = setTimeout(() => finish("PIECE_TIMEOUT"), limits.lifetimeTimeoutMs);

  client.on("data", (chunk) => {
    upstreamBytes += chunk.length;
    if (upstreamBytes > manifest.maximumProviderUpstreamBytes) return finish("PIECE_EGRESS_DENIED");
    if (upstream) return void upstream.write(chunk);
    clientHello = Buffer.concat([clientHello, chunk]);
    if (resolving) return;
    const parsed = parseTlsClientHello(clientHello);
    if (parsed.pending) return;
    if (parsed.error) return finish("PIECE_EGRESS_DENIED");
    const destination = approvedDestinationForHostname(manifest, parsed.hostname);
    if (!destination) return finish("PIECE_EGRESS_DENIED");
    approvedDestination = destination;
    resolving = true;
    client.pause();
    clearTimeout(handshakeTimer);
    void resolveManifestDestination(destination, { timeoutMs: limits.connectTimeoutMs })
      .then((resolved) => {
        emit({
          event: "piece_gateway_dns",
          requestId,
          capabilityId: manifest.capabilityId,
          hostname: resolved.hostname,
          port: resolved.port,
          pinnedFamily: resolved.family,
          answers: resolved.evidence,
          outcome: "SAFE",
        });
        upstream = connectTcp({ host: resolved.pinnedAddress, port: destination.port, family: resolved.family });
        connectTimer = setTimeout(() => finish("PIECE_TIMEOUT"), limits.connectTimeoutMs);
        upstream.setTimeout(limits.idleTimeoutMs, () => finish("PIECE_TIMEOUT"));
        upstream.once("connect", () => {
          clearTimeout(connectTimer);
          upstream.write(clientHello);
          clientHello.fill(0);
          clientHello = Buffer.alloc(0);
          client.resume();
        });
        upstream.on("data", (data) => {
          downstreamBytes += data.length;
          if (downstreamBytes > manifest.maximumProviderDownstreamBytes) {
            return finish("PIECE_RESPONSE_INVALID");
          }
          client.write(data);
        });
        upstream.once("error", () => finish("PIECE_PROVIDER_UNAVAILABLE"));
        upstream.once("end", () => finish("PIECE_GATEWAY_SUCCEEDED"));
      })
      .catch(() => finish("PIECE_EGRESS_DENIED"));
  });
  client.once("error", () => finish("PIECE_EGRESS_DENIED"));
  client.once("end", () => finish(upstream ? "PIECE_GATEWAY_SUCCEEDED" : "PIECE_EGRESS_DENIED"));
}

emit(runtimeEvidence());
createServer(handleClient).listen(443, "0.0.0.0", () => {
  emit({
    event: "piece_gateway_ready",
    requestId,
    capabilityId: manifest.capabilityId,
    destinations: manifest.destinations.map(({ hostname, port, protocol }) => ({ hostname, port, protocol })),
  });
});
