import { Resolver } from "node:dns/promises";
import { createServer, connect as connectTcp } from "node:net";

import {
  EGRESS_BROKER_MAX_DATA_CONNECTIONS,
  EGRESS_BROKER_SOCKET_PATH,
} from "./egress-broker-constants.mjs";
import {
  currentInterfaceAddresses,
  EgressBrokerPolicyStore,
  startEgressBrokerControlServer,
} from "./egress-broker-control.mjs";
import { resolveManifestDestination } from "./dns-policy.mjs";
import { parseTlsClientHello } from "./tls-client-hello.mjs";

function safeLog(logger, event) {
  try { logger(Object.freeze(event)); } catch {}
}

export function handleBrokerClient(client, { policyStore, connectProvider = connectTcp, logger = () => undefined }) {
  let clientHello = Buffer.alloc(0);
  let upstream = null;
  let lease = null;
  let upstreamConnections = 0;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let finished = false;
  let handshakeTimer;
  let connectTimer;
  let lifetimeTimer;

  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    clearTimeout(handshakeTimer);
    clearTimeout(connectTimer);
    clearTimeout(lifetimeTimer);
    clientHello.fill(0);
    clientHello = Buffer.alloc(0);
    upstream?.destroy();
    client.destroy();
    lease?.release();
    safeLog(logger, {
      event: "piece_egress_broker_connection",
      invocationId: lease?.invocationId ?? null,
      requestId: lease?.requestId ?? null,
      capabilityId: lease?.capabilityId ?? null,
      hostname: lease?.destination?.hostname ?? null,
      port: lease?.destination?.port ?? null,
      upstreamConnections,
      upstreamBytes,
      downstreamBytes,
      outcome,
    });
  };

  client.on("data", (chunk) => {
    if (finished) return;
    upstreamBytes += chunk.length;
    if (lease && upstreamBytes > lease.limits.maximumProviderUpstreamBytes) return finish("PIECE_EGRESS_DENIED");
    if (upstream) return void upstream.write(chunk);
    clientHello = Buffer.concat([clientHello, chunk]);
    if (clientHello.length > 16 * 1024) return finish("PIECE_EGRESS_DENIED");
    const parsed = parseTlsClientHello(clientHello);
    if (parsed.pending) return;
    if (parsed.error) return finish("PIECE_EGRESS_DENIED");
    try {
      lease = policyStore.authorize(client.localAddress, parsed.hostname);
    } catch {
      return finish("PIECE_EGRESS_DENIED");
    }
    if (upstreamConnections !== 0) return finish("PIECE_EGRESS_DENIED");
    upstreamConnections = 1;
    clearTimeout(handshakeTimer);
    lifetimeTimer = setTimeout(() => finish("PIECE_TIMEOUT"), lease.limits.lifetimeTimeoutMs);
    upstream = connectProvider({
      host: lease.destination.pinnedAddress,
      port: lease.destination.port,
      family: lease.destination.family,
    });
    client.pause();
    connectTimer = setTimeout(() => finish("PIECE_TIMEOUT"), lease.limits.connectTimeoutMs);
    upstream.setTimeout(lease.limits.idleTimeoutMs, () => finish("PIECE_TIMEOUT"));
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      upstream.write(clientHello);
      clientHello.fill(0);
      clientHello = Buffer.alloc(0);
      client.resume();
    });
    upstream.on("data", (data) => {
      downstreamBytes += data.length;
      if (downstreamBytes > lease.limits.maximumProviderDownstreamBytes) return finish("PIECE_RESPONSE_INVALID");
      client.write(data);
    });
    upstream.once("error", () => finish("PIECE_PROVIDER_UNAVAILABLE"));
    upstream.once("end", () => finish("PIECE_BROKER_SUCCEEDED"));
  });
  client.once("error", () => finish("PIECE_EGRESS_DENIED"));
  client.once("end", () => finish(upstream ? "PIECE_BROKER_SUCCEEDED" : "PIECE_EGRESS_DENIED"));
  handshakeTimer = setTimeout(() => finish("PIECE_TIMEOUT"), 1_500);
  return Object.freeze({ finish });
}

export async function startEgressBroker({
  socketPath = EGRESS_BROKER_SOCKET_PATH,
  resolver = new Resolver(),
  baselineAddresses = currentInterfaceAddresses(),
  listInterfaceAddresses = currentInterfaceAddresses,
  logger = (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  connectProvider = connectTcp,
  createDataServer = createServer,
} = {}) {
  const policyStore = new EgressBrokerPolicyStore({
    baselineAddresses,
    listInterfaceAddresses,
    logger,
    resolveDestination: (destination) => resolveManifestDestination(destination, {
      resolve4: (hostname) => resolver.resolve4(hostname, { ttl: true }),
      resolve6: (hostname) => resolver.resolve6(hostname, { ttl: true }),
    }),
  });
  const control = await startEgressBrokerControlServer({ policyStore, socketPath });
  const dataServer = createDataServer((client) => handleBrokerClient(client, { policyStore, connectProvider, logger }));
  dataServer.maxConnections = EGRESS_BROKER_MAX_DATA_CONNECTIONS;
  try {
    await new Promise((resolve, reject) => {
      dataServer.once("error", reject);
      dataServer.listen(443, "0.0.0.0", resolve);
    });
  } catch (error) {
    await control.stop();
    throw error;
  }
  safeLog(logger, { event: "piece_egress_broker_ready", protocolVersion: 1, status: "ready" });
  return Object.freeze({
    policyStore,
    control,
    dataServer,
    async stop() {
      await Promise.all([
        control.stop(),
        new Promise((resolve) => dataServer.close(resolve)),
      ]);
    },
  });
}

async function main() {
  const broker = await startEgressBroker();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await broker.stop(); process.exitCode = 0; } catch { process.exitCode = 1; }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

if (process.argv[1]?.endsWith("egress-broker.mjs")) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ event: "piece_egress_broker_start_failed", errorCode: "PIECE_EGRESS_DENIED" })}\n`);
    process.exitCode = 1;
  });
}
